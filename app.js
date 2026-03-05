import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

// ---- 全域狀態存放 ----
let siteName = '未命名站點';
let gpsData = { lat: 0, lng: 0 };
let selectedModels = [];
let currentModelIndex = 0;

// ---- Three.js 與 WebXR 全域變數 ----
let camera, scene, renderer;
let controller;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let placedBillboards = []; // 存放已放置的機台

initUI();
initThree();

// ------------------------------------------------------------------
// 1. 初始化介面與 GPS API
// ------------------------------------------------------------------
function initUI() {
    const gpsStatus = document.getElementById('gps-status');

    // 取得 GPS
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                gpsData.lat = pos.coords.latitude.toFixed(6);
                gpsData.lng = pos.coords.longitude.toFixed(6);
                gpsStatus.textContent = `Lat: ${gpsData.lat}, Lng: ${gpsData.lng}`;
                document.getElementById('wm-gps').textContent = `GPS: ${gpsData.lat}, ${gpsData.lng}`;
            },
            (err) => {
                gpsStatus.textContent = `無法取得 GPS (${err.message})`;
            },
            { enableHighAccuracy: true }
        );
    } else {
        gpsStatus.textContent = "瀏覽器不支援 GPS";
    }

    // 監聽站點輸入
    document.getElementById('site-name').addEventListener('input', (e) => {
        siteName = e.target.value || '未命名站點';
        document.getElementById('wm-site').textContent = `站點: ${siteName}`;
    });

    // 拍照按鈕
    document.getElementById('btn-shutter').addEventListener('click', takeScreenshot);

    // 繼續或重新開始
    document.getElementById('btn-continue').addEventListener('click', () => {
        document.getElementById('post-ar-ui').classList.add('hidden');
        // 回到拍攝介面
    });

    document.getElementById('btn-restart').addEventListener('click', () => {
        // 簡單作法：重新整理網頁
        window.location.reload();
    });

    // ========== 匯入照片合成模式 Start ==========
    const fileInput = document.getElementById('image-upload');
    document.getElementById('btn-photo-import').addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('#model-list input:checked');
        if (checkboxes.length === 0) {
            alert("請至少先選擇一個機型");
            return;
        }
        selectedModels = Array.from(checkboxes).map(cb => ({
            w: parseFloat(cb.dataset.w) / 100, // 公分轉公尺
            h: parseFloat(cb.dataset.h) / 100,
            img: cb.dataset.img
        }));
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                startPhotoARMode(event.target.result);
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById('btn-photo-shutter').addEventListener('click', takePhotoScreenshot);
    // ========== 匯入照片合成模式 End ==========

    // 每秒更新一次浮水印時間
    setInterval(() => {
        const now = new Date();
        document.getElementById('wm-time').textContent = now.toLocaleString();
        document.getElementById('photo-wm-time').textContent = now.toLocaleString();
    }, 1000);

    // 啟動水平儀
    initLevelMeter();
}

// ------------------------------------------------------------------
// 2. 初始化水平儀 (傾角偵測)
// ------------------------------------------------------------------
function initLevelMeter() {
    const bubble = document.getElementById('level-bubble');

    window.addEventListener('deviceorientation', (e) => {
        // e.beta: 前後傾斜 (-180 to 180). 正常直立拿手機約為 90 度
        // e.gamma: 左右傾斜 (-90 to 90). 正常平放約為 0 度
        if (e.beta !== null && e.gamma !== null) {
            // 假設我們需要用戶將手機垂直 (beta = 90), gamma = 0
            let dy = (e.beta - 90) * 3; // 放大倍率
            let dx = e.gamma * 3;

            // 限制泡泡不要超出外框 (半徑約 40px)
            const maxRadius = 40;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > maxRadius) {
                dx = (dx / distance) * maxRadius;
                dy = (dy / distance) * maxRadius;
            }

            bubble.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

            // 若很接近水平垂直 (dx, dy 都在極小範圍)，變更顏色為藍色作為提示
            if (distance < 5) {
                bubble.style.backgroundColor = '#00ffff';
            } else {
                bubble.style.backgroundColor = '#00ff00';
            }
        }
    });
}

// ------------------------------------------------------------------
// 3. Three.js 與 WebXR 初始化
// ------------------------------------------------------------------
function initThree() {
    const container = document.createElement('div');
    document.body.appendChild(container);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 3);
    light.position.set(0.5, 1, 0.25);
    scene.add(light);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); // preserveDrawingBuffer 允許 toDataURL()
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    // 建立 AR 按鈕並置入 UI (確保按鈕被點擊時，我們先讀取使用者選項)
    const arButton = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] });
    arButton.addEventListener('click', () => {
        // 進入 AR 模式前，收集選中的 Model
        const checkboxes = document.querySelectorAll('#model-list input:checked');
        selectedModels = Array.from(checkboxes).map(cb => ({
            w: parseFloat(cb.dataset.w) / 100, // 公分轉公尺
            h: parseFloat(cb.dataset.h) / 100,
            img: cb.dataset.img
        }));

        if (selectedModels.length === 0) {
            alert("請至少選擇一個機型");
            return;
        }

        // 切換 UI 層
        document.getElementById('setup-ui').classList.add('hidden');
        document.getElementById('ar-ui').classList.remove('hidden');
    });

    document.getElementById('ar-button-container').appendChild(arButton);

    // 控制器 (點擊螢幕)
    controller = renderer.xr.getController(0);
    controller.addEventListener('select', onSelect);
    scene.add(controller);

    // 地標 (Reticle)
    reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    window.addEventListener('resize', onWindowResize);
    renderer.setAnimationLoop(render);
}

// 依照 2.5d-billboard 邏輯產生 PlaneGeometry
function createBillboard(modelDef) {
    const textureLoader = new THREE.TextureLoader();
    const texture = textureLoader.load(modelDef.img);
    texture.colorSpace = THREE.SRGBColorSpace;

    // 1. Entity & 3. Dimensions
    const geometry = new THREE.PlaneGeometry(modelDef.w, modelDef.h);
    geometry.translate(0, modelDef.h / 2, 0); // 中心對齊到底邊

    // 2. Material
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false // 避免透明邊緣穿插破圖
    });

    return new THREE.Mesh(geometry, material);
}

function onSelect() {
    if (reticle.visible && selectedModels.length > 0) {
        // 循環拿取使用者所選機台
        const currentDef = selectedModels[currentModelIndex % selectedModels.length];

        // 建立 2.5D 看板
        const billboard = createBillboard(currentDef);

        // 將看板放到 Reticle 的位置
        billboard.position.setFromMatrixPosition(reticle.matrix);
        // 面向攝影機
        billboard.lookAt(camera.position.x, billboard.position.y, camera.position.z);

        scene.add(billboard);
        placedBillboards.push(billboard);

        // 切換到下一個選取的模型（如果有選多的話）
        currentModelIndex++;

        // 放置後可先隱藏 Reticle
        reticle.visible = false;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function render(timestamp, frame) {
    if (frame) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        const session = renderer.xr.getSession();

        if (!hitTestSourceRequested) {
            session.requestReferenceSpace('viewer').then((refSpace) => {
                session.requestHitTestSource({ space: refSpace }).then((source) => {
                    hitTestSource = source;
                });
            });
            session.addEventListener('end', () => {
                hitTestSourceRequested = false;
                hitTestSource = null;
                // 離開 AR 模式時，重置 UI
                document.getElementById('setup-ui').classList.remove('hidden');
                document.getElementById('ar-ui').classList.add('hidden');
                document.getElementById('post-ar-ui').classList.add('hidden');
            });
            hitTestSourceRequested = true;
        }

        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                reticle.visible = true;
                reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
            } else {
                reticle.visible = false;
            }
        }

        // 讓所有放置的看板隨時轉向攝影機 (Y 軸對齊)
        placedBillboards.forEach(bb => {
            bb.lookAt(camera.position.x, bb.position.y, camera.position.z);
        });
    }
    renderer.render(scene, camera);
}

// ------------------------------------------------------------------
// 4. 浮水印與存檔邏輯 (雙重存檔的合成解法 MVP)
// ------------------------------------------------------------------
function takeScreenshot() {
    // 注意：在 WebXR 模式下，renderer.domElement.toDataURL 只會截取 3D 內容 (因背後相機層屬各 OS 系統控制)
    // 若為原生結合 WebView 可取完整畫面。本 Demo 合成浮水印於 3D 透明層上供測試。

    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');

    // 1. 畫上 3D 模型圖層
    ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);

    // 2. 疊加浮水印背景與文字
    const padding = 20;
    ctx.font = '32px sans-serif'; // 依據設備像素比放大字體
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';

    const now = new Date().toLocaleString();
    const line1 = `站點: ${siteName}`;
    const line2 = `GPS: ${gpsData.lat}, ${gpsData.lng}`;
    const line3 = `${now}`;

    // 為了字體清楚，畫黑色半透明底框
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    const boxWidth = 500;
    const boxHeight = 120;
    ctx.fillRect(canvas.width - boxWidth - padding, canvas.height - boxHeight - padding, boxWidth, boxHeight);

    // 寫字
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line1, canvas.width - padding - 10, canvas.height - padding - 80);
    ctx.fillText(line2, canvas.width - padding - 10, canvas.height - padding - 45);
    ctx.fillText(line3, canvas.width - padding - 10, canvas.height - padding - 10);

    // 3. 輸出並觸發下載
    const dataURL = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `場勘_${siteName}_${Date.now()}.png`;
    a.click();

    // 顯示拍攝完成對話框
    document.getElementById('post-ar-ui').classList.remove('hidden');
}

// ==================================================================
// 5. 匯入照片合成模式 (Offline AR)
// ==================================================================
let photoScene, photoCamera, photoRenderer;
let photoTargetBillboard = null; // 當前被選中要在相片上操作的看板
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let initialPinchDistance = null;
let initialScale = { x: 1, y: 1, z: 1 };

function startPhotoARMode(imageSrc) {
    document.getElementById('setup-ui').classList.add('hidden');
    document.getElementById('photo-ar-ui').classList.remove('hidden');

    const container = document.createElement('div');
    container.id = 'photo-ar-container';
    container.style.position = 'absolute';
    container.style.top = '0'; container.style.left = '0';
    container.style.width = '100%'; container.style.height = '100%';
    container.style.zIndex = '5';
    document.body.appendChild(container);

    photoScene = new THREE.Scene();

    // 載入背景照片
    const loader = new THREE.TextureLoader();
    loader.load(imageSrc, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        photoScene.background = texture;
    });

    photoCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
    // 將相機往後拉一點以看見完整平面
    photoCamera.position.z = 5;

    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 3);
    light.position.set(0.5, 1, 0.25);
    photoScene.add(light);

    photoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    photoRenderer.setPixelRatio(window.devicePixelRatio);
    photoRenderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(photoRenderer.domElement);

    // 實例化第一個選擇的看板放到畫面中央
    if (selectedModels.length > 0) {
        photoTargetBillboard = createBillboard(selectedModels[0]);
        // 放低一點比較像在地板
        photoTargetBillboard.position.set(0, -1, 0);
        photoScene.add(photoTargetBillboard);
    }

    // 綁定手勢事件
    photoRenderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    photoRenderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    photoRenderer.domElement.addEventListener('touchend', onTouchEnd, { passive: false });

    // 針對桌面測試綁定滑鼠
    photoRenderer.domElement.addEventListener('mousedown', (e) => onTouchStart({ touches: [e] }));
    photoRenderer.domElement.addEventListener('mousemove', (e) => onTouchMove({ touches: [e], preventDefault: () => { } }));
    photoRenderer.domElement.addEventListener('mouseup', onTouchEnd);

    photoRenderer.setAnimationLoop(() => {
        photoRenderer.render(photoScene, photoCamera);
    });
}

function onTouchStart(e) {
    if (!photoTargetBillboard) return;
    if (e.touches.length === 1) {
        isDragging = true;
        previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
        initialScale = { ...photoTargetBillboard.scale };
    }
}

function onTouchMove(e) {
    e.preventDefault(); // 防止滾頁面
    if (!photoTargetBillboard) return;

    if (isDragging && e.touches.length === 1) {
        const deltaX = e.touches[0].clientX - previousMousePosition.x;
        const deltaY = e.touches[0].clientY - previousMousePosition.y;

        // 根據畫面滑動量微調 3D 座標 (數值可依比例調整)
        photoTargetBillboard.position.x += deltaX * 0.01;
        photoTargetBillboard.position.y -= deltaY * 0.01; // DOM Y 往下為正，3D Y 往上為正

        previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && initialPinchDistance) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const pinchScale = distance / initialPinchDistance;
        photoTargetBillboard.scale.set(
            initialScale.x * pinchScale,
            initialScale.y * pinchScale,
            initialScale.z * pinchScale
        );
    }
}

function onTouchEnd(e) {
    isDragging = false;
    initialPinchDistance = null;
}

function takePhotoScreenshot() {
    if (!photoRenderer) return;

    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');

    // 將 3D (含已經綁定在 Background 的底圖) 畫上去
    ctx.drawImage(photoRenderer.domElement, 0, 0, canvas.width, canvas.height);

    // 疊加浮水印
    const padding = 20;
    ctx.font = '32px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';

    const now = new Date().toLocaleString();
    const line1 = `站點: ${siteName}`;
    const line2 = `GPS: ${gpsData.lat}, ${gpsData.lng}`;
    const line3 = `${now}`;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    const boxWidth = 500;
    const boxHeight = 120;
    ctx.fillRect(canvas.width - boxWidth - padding, canvas.height - boxHeight - padding, boxWidth, boxHeight);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(line1, canvas.width - padding - 10, canvas.height - padding - 80);
    ctx.fillText(line2, canvas.width - padding - 10, canvas.height - padding - 45);
    ctx.fillText(line3, canvas.width - padding - 10, canvas.height - padding - 10);

    const dataURL = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `合成場勘_${siteName}_${Date.now()}.png`;
    a.click();

    // 返回初始化
    document.getElementById('post-ar-ui').classList.remove('hidden');
    document.getElementById('photo-ar-ui').classList.add('hidden');
    const container = document.getElementById('photo-ar-container');
    if (container) {
        container.remove();
    }
}
