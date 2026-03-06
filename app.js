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

    // 啟動 GPS 請求時的防卡死邏輯
    setTimeout(() => {
        if (gpsStatus.textContent === "等待授權中...") {
            gpsStatus.textContent = "等待授權中 (請注意瀏覽器權限提示)";
        }
    }, 3000);

    // 監聽站點輸入
    document.getElementById('site-name').addEventListener('input', (e) => {
        siteName = e.target.value || '未命名站點';
        document.getElementById('wm-site').textContent = `站點: ${siteName}`;
    });

    // 拍照按鈕
    document.getElementById('btn-shutter').addEventListener('click', takeScreenshot);

    // 繼續或重新開始
    document.getElementById('btn-continue').addEventListener('click', () => {
        // 隱藏完成面板
        document.getElementById('post-ar-ui').classList.add('hidden');

        // 重新顯示剛剛隱藏起來的拍照與編輯控制項與操作層，完全不銷毀畫布與照片
        if (currentARMode === 'photo_import' || currentARMode === 'live_video') {
            document.getElementById('photo-ar-ui').classList.remove('hidden');
        } else {
            document.getElementById('ar-ui').classList.remove('hidden');
        }
    });

    document.getElementById('btn-restart').addEventListener('click', () => {
        // 簡單作法：重新整理網頁
        window.location.reload();
    });

    // ========== 匯入與拍照合成模式 Start ==========
    const importInput = document.getElementById('image-upload');

    function prepareModels() {
        const checkboxes = document.querySelectorAll('#model-list input:checked');
        if (checkboxes.length === 0) {
            alert("請至少先選擇一個機型");
            return false;
        }
        selectedModels = Array.from(checkboxes).map(cb => ({
            w: parseFloat(cb.dataset.w) / 100,
            h: parseFloat(cb.dataset.h) / 100,
            d: (parseFloat(cb.dataset.d) || 50) / 100,
            color: cb.dataset.color || '#888888',
            img: cb.dataset.img,
            imgL: cb.dataset.imgL || null,
            imgR: cb.dataset.imgR || null
        }));
        return true;
    }

    document.getElementById('btn-photo-import').addEventListener('click', () => {
        if (prepareModels()) {
            importInput.classList.remove('hidden');
            importInput.style.opacity = '0';
            importInput.style.position = 'absolute';
            importInput.click();
            importInput.classList.add('hidden');
        }
    });

    document.getElementById('btn-photo-capture').addEventListener('click', () => {
        if (prepareModels()) startLiveVideoMode();
    });

    importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                // 強制透過 canvas 重繪來消除 iOS/Android 所帶的 EXIF Orientation 問題
                fixImageOrientation(event.target.result, (fixedBase64) => {
                    startPhotoARMode(fixedBase64);
                });
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });

    // --- 消除 EXIF 旋轉問題與縮放超大圖片防呆的工具 ---
    function fixImageOrientation(base64Image, callback) {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            let targetW = img.naturalWidth;
            let targetH = img.naturalHeight;
            const MAX_SIZE = 2560; // 限制最大解析度以防 WebGL Texture 記憶體爆掉

            if (targetW > MAX_SIZE || targetH > MAX_SIZE) {
                if (targetW > targetH) {
                    targetH = Math.round((targetH * MAX_SIZE) / targetW);
                    targetW = MAX_SIZE;
                } else {
                    targetW = Math.round((targetW * MAX_SIZE) / targetH);
                    targetH = MAX_SIZE;
                }
            }

            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, targetW, targetH);
            callback(canvas.toDataURL("image/jpeg", 0.9));
        };
        img.src = base64Image;
    }

    document.getElementById('btn-photo-shutter').addEventListener('click', takePhotoScreenshot);
    // ========== 匯入與拍照合成模式 End ==========

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

    // 建立 AR 按鈕並置入 UI
    const arButtonContainer = document.getElementById('ar-button-container');
    if (navigator.xr) {
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            if (!supported) {
                document.getElementById('ios-hint').classList.remove('hidden');
                arButtonContainer.classList.add('hidden'); // 不支援就隱藏，避免出現奇怪按鈕
            }
        });
    } else {
        document.getElementById('ios-hint').classList.remove('hidden');
        arButtonContainer.classList.add('hidden');
    }

    const arButton = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] });
    arButton.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('#model-list input:checked');
        if (checkboxes.length === 0) {
            alert("請至少選擇一個機型");
        }
        selectedModels = Array.from(checkboxes).map(cb => ({
            w: parseFloat(cb.dataset.w) / 100,
            h: parseFloat(cb.dataset.h) / 100,
            d: (parseFloat(cb.dataset.d) || 50) / 100,
            color: cb.dataset.color || '#888888', // 取出主題色
            img: cb.dataset.img,
            imgL: cb.dataset.imgL || null,
            imgR: cb.dataset.imgR || null,
            imgB: cb.dataset.imgB || null
        }));
        document.getElementById('setup-ui').classList.add('hidden');
        document.getElementById('ar-ui').classList.remove('hidden');
    });
    arButtonContainer.appendChild(arButton);

    controller = renderer.xr.getController(0);
    controller.addEventListener('select', onSelect);
    scene.add(controller);

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

function createMachine3D(modelDef) {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');

    // 解析我們給予的 Hex 色碼字串為 THREE.Color 物件
    const themeColor = new THREE.Color(modelDef.color);

    // 準備 6 面材質 [右, 左, 上, 下, 正, 背]
    const materials = [];
    const faceConfigs = [
        { key: 'imgR', fallback: modelDef.img }, // 右
        { key: 'imgL', fallback: modelDef.img }, // 左
        { key: null, color: themeColor },        // 上 (套用主題色)
        { key: null, color: themeColor },        // 下 (套用主題色)
        { key: 'img', fallback: modelDef.img },  // 正
        { key: 'imgB', color: themeColor }       // 背 (如果有 imgB 則用，否則用主題色)
    ];

    faceConfigs.forEach((config) => {
        const path = config.key ? (modelDef[config.key] || config.fallback) : null;
        if (path) {
            const texture = textureLoader.load(
                path,
                (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                },
                undefined,
                (err) => {
                    console.error(`🔴 貼圖加載失敗: ${path}`);
                }
            );
            materials.push(new THREE.MeshBasicMaterial({
                map: texture,
                transparent: !!path.includes('.png'), // 如果是 png 則啟用透明度
                alphaTest: 0.1
            }));
        } else {
            materials.push(new THREE.MeshBasicMaterial({ color: config.color }));
        }
    });

    // 1. Entity: 建立 Box 幾何體
    const geometry = new THREE.BoxGeometry(modelDef.w, modelDef.h, modelDef.d);
    // 將中心點移至底部
    geometry.translate(0, modelDef.h / 2, 0);

    // 3. Dimensions: 結合幾何與材質建立模型
    return new THREE.Mesh(geometry, materials);
}

function onSelect() {
    if (reticle.visible && selectedModels.length > 0) {
        const currentDef = selectedModels[currentModelIndex % selectedModels.length];
        const machine = createMachine3D(currentDef);
        machine.position.setFromMatrixPosition(reticle.matrix);
        // 面向攝影機，但保持垂直
        machine.lookAt(camera.position.x, machine.position.y, camera.position.z);
        scene.add(machine);
        placedBillboards.push(machine);
        currentModelIndex++;
        reticle.visible = false;
    }
}

// --- 統一的橫直向判斷 ---
function checkIsLandscape() {
    // 優先使用 screen orientation API
    if (window.screen && window.screen.orientation) {
        return window.screen.orientation.type.includes('landscape');
    }
    // 其次使用 window.orientation (舊版 iOS)
    if (typeof window.orientation !== 'undefined') {
        return Math.abs(window.orientation) === 90;
    }
    // 最後 fallback 寬高比
    return window.innerWidth > window.innerHeight;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (photoRenderer) {
        photoCamera.aspect = window.innerWidth / window.innerHeight;
        photoCamera.updateProjectionMatrix();
        photoRenderer.setSize(window.innerWidth, window.innerHeight);

        // 即時檢查當下方向並翻轉機台
        if (photoGroup) {
            const isLandscape = checkIsLandscape();
            if (isLandscape) {
                photoGroup.rotation.z = Math.PI / 2;
                initialRotation = Math.PI / 2;
            } else {
                photoGroup.rotation.z = 0;
                initialRotation = 0;
            }
        }
    }

    // 如果即時視訊存在，稍微觸發它重新套用 CSS cover 以因應螢幕旋轉
    if (typeof liveVideoElement !== 'undefined' && liveVideoElement) {
        liveVideoElement.style.width = window.innerWidth + 'px';
        liveVideoElement.style.height = window.innerHeight + 'px';
    }
}

// 監聽轉向事件 (針對不一定觸發 resize 或延遲的 iOS/Android)
window.addEventListener("orientationchange", () => {
    setTimeout(onWindowResize, 100); // 延遲一下讓瀏覽器畫布更新
});

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

        placedBillboards.forEach(bb => {
            bb.lookAt(camera.position.x, bb.position.y, camera.position.z);
        });
    }
    renderer.render(scene, camera);
}

function takeScreenshot() {
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);

    // 浮水印邏輯同下略... (此處為 AR 截圖)
    const contentRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    finishAndDownload(canvas, contentRect, `AR場勘_${siteName}`);
}

// 離線合成模式 / WebRTC 即時相機模式
let photoScene, photoCamera, photoRenderer;
let photoGroup = null; // 將所有機台放入單一群組連動
let localVideoStream = null;
let liveVideoElement = null;
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let initialPinchDistance = null;
let initialPinchAngle = null;
let initialScale = null;
let initialRotation = null;
let interactionMode = 'move'; // 'move', 'rotate'
let currentARMode = null; // 'live_video', 'photo_import', 'webxr'

function cleanupARSession() {
    // 關閉時清除背景，釋放記憶體
    const bgImg = document.getElementById("native-photo-bg");
    if (bgImg) {
        bgImg.src = "";
        bgImg.classList.add('hidden');
    }

    document.getElementById('photo-ar-ui').classList.add('hidden');
    document.getElementById('ar-ui').classList.add('hidden');

    const container = document.getElementById('photo-ar-container');
    if (container) {
        container.remove();
    }
    if (photoRenderer) {
        photoRenderer.setAnimationLoop(null);
        photoRenderer = null;
    }

    // 關閉相機串流
    if (localVideoStream) {
        localVideoStream.getTracks().forEach(track => track.stop());
        localVideoStream = null;
    }
    if (liveVideoElement) {
        liveVideoElement.remove();
        liveVideoElement = null;
    }

    photoGroup = null;
}

function startCommonARMode() {
    document.getElementById('setup-ui').classList.add('hidden');
    document.getElementById('photo-ar-ui').classList.remove('hidden');

    const container = document.createElement('div');
    container.id = 'photo-ar-container';
    container.style.position = 'fixed';
    container.style.top = '0'; container.style.left = '0';
    container.style.width = '100vw'; container.style.height = '100vh';
    container.style.zIndex = '5';
    container.style.touchAction = 'none'; // 防止 iOS/Android 原生畫面縮拉扯
    document.body.appendChild(container);

    photoScene = new THREE.Scene();
    photoCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
    photoCamera.position.z = 8;

    const light = new THREE.AmbientLight(0xffffff, 2.0);
    photoScene.add(light);

    photoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    photoRenderer.setPixelRatio(window.devicePixelRatio);
    photoRenderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(photoRenderer.domElement);

    const btnMove = document.getElementById('btn-mode-move');
    const btnRotate = document.getElementById('btn-mode-rotate');
    interactionMode = 'move';

    btnMove.onclick = () => {
        btnRotate.classList.remove('highlight');
        btnMove.classList.add('highlight');
        interactionMode = 'move';
    };

    btnRotate.onclick = () => {
        btnMove.classList.remove('highlight');
        btnRotate.classList.add('highlight');
        interactionMode = 'rotate';
    };

    document.getElementById('btn-scale-up').onclick = () => { if (photoGroup) photoGroup.scale.multiplyScalar(1.1); };
    document.getElementById('btn-scale-down').onclick = () => { if (photoGroup) photoGroup.scale.multiplyScalar(0.9); };

    // 一鍵強制旋轉 90 度 (順時針平轉)
    const rotateBtn = document.getElementById('btn-force-rotate');
    rotateBtn.onclick = () => {
        if (photoGroup) {
            photoGroup.rotation.z -= Math.PI / 2; // 轉 90 度
            initialRotation = photoGroup.rotation.z; // 更新基準面
        }
    };

    // 一鍵還原到預設狀態
    document.getElementById('btn-reset-machine').onclick = () => {
        if (photoGroup) {
            photoGroup.position.set(0, 0, 0);
            photoGroup.rotation.set(0, 0, initialRotation);
            photoGroup.scale.set(1, 1, 1);
        }
    };

    photoGroup = new THREE.Group();
    photoScene.add(photoGroup);

    // 初始判斷當前螢幕是否為橫式
    const isLandscape = checkIsLandscape();
    if (isLandscape) {
        photoGroup.rotation.z = Math.PI / 2;
        initialRotation = Math.PI / 2;
    } else {
        photoGroup.rotation.z = 0;
        initialRotation = 0;
    }

    // 計算總寬度與 10cm 間隙
    let totalWidth = 0;
    selectedModels.forEach(modelDef => { totalWidth += modelDef.w; });
    totalWidth += (selectedModels.length - 1) * 0.1; // 加上每台之間 10cm 的間距

    let currentX = -totalWidth / 2;
    selectedModels.forEach((modelDef) => {
        const machine = createMachine3D(modelDef);
        // 設定位置：目前 X 起點加上該機台一半的寬度
        machine.position.set(currentX + modelDef.w / 2, -1, 1);
        photoGroup.add(machine);
        currentX += modelDef.w + 0.1; // 累加至下一台的起點
    });

    photoRenderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    photoRenderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    photoRenderer.domElement.addEventListener('touchend', onTouchEnd);

    // 電腦滑鼠支援
    photoRenderer.domElement.addEventListener('mousedown', onMouseDown);
    photoRenderer.domElement.addEventListener('mousemove', onMouseMove);
    photoRenderer.domElement.addEventListener('mouseup', onMouseUp);
    photoRenderer.domElement.addEventListener('mouseleave', onMouseUp);
    photoRenderer.domElement.addEventListener('wheel', onMouseWheel, { passive: false });

    photoRenderer.setAnimationLoop(() => {
        photoRenderer.render(photoScene, photoCamera);
    });
}

function startPhotoARMode(imageSrc) {
    currentARMode = 'photo_import';
    startCommonARMode();
    // 使用原生的 HTML <img> 標籤處理照片，徹底解決所有廠牌的 EXIF 與截切問題
    const bgImg = document.getElementById('native-photo-bg');
    bgImg.src = imageSrc;
    bgImg.classList.remove('hidden');
}

function startLiveVideoMode() {
    currentARMode = 'live_video';
    startCommonARMode();
    // 建立影像元素作為背景
    liveVideoElement = document.createElement('video');
    liveVideoElement.setAttribute('autoplay', '');
    liveVideoElement.setAttribute('playsinline', '');
    liveVideoElement.setAttribute('muted', '');
    liveVideoElement.style.position = 'fixed';
    liveVideoElement.style.top = '0';
    liveVideoElement.style.left = '0';
    liveVideoElement.style.width = '100vw';
    liveVideoElement.style.height = '100vh';
    liveVideoElement.style.objectFit = 'cover';
    liveVideoElement.style.zIndex = '1'; // 放最底層
    document.body.appendChild(liveVideoElement);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(stream => {
            localVideoStream = stream;
            liveVideoElement.srcObject = stream;

            // 當相機畫面準備好時，進行更精確的旋轉判定
            liveVideoElement.onloadedmetadata = () => {
                liveVideoElement.play().catch(e => console.warn(e));

                if (photoGroup) {
                    // 以相機回傳的實際影像比例來決定是否橫向
                    const cameraIsLandscape = liveVideoElement.videoWidth > liveVideoElement.videoHeight;
                    // 以視窗比例來決定是否橫向
                    const windowIsLandscape = checkIsLandscape();

                    // 若相機傳來的是橫的，或視窗是橫的，我們都嘗試將機台打橫
                    if (cameraIsLandscape || windowIsLandscape) {
                        photoGroup.rotation.z = Math.PI / 2;
                        initialRotation = Math.PI / 2;
                    } else {
                        photoGroup.rotation.z = 0;
                        initialRotation = 0;
                    }
                }
            };
        })
        .catch(err => {
            alert("相機授權失敗或不支援，請改用「從相簿匯入舊照」模式。(" + err.message + ")");
            window.location.reload();
        });
}

function onTouchStart(e) {
    if (!photoGroup) return;

    if (e.touches.length === 1) {
        isDragging = true;
        previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
        initialPinchAngle = Math.atan2(dy, dx);
        initialScale = photoGroup.scale.x;
        initialRotation = photoGroup.rotation.z; // 雙指平轉改為 Z 軸 rolling
    }
}

function onTouchMove(e) {
    if (e.cancelable) e.preventDefault();
    if (!photoGroup) return;

    if (isDragging && e.touches.length === 1) {
        const deltaX = e.touches[0].clientX - previousMousePosition.x;
        const deltaY = e.touches[0].clientY - previousMousePosition.y;

        if (interactionMode === 'move') {
            photoGroup.position.x += deltaX * 0.015;
            photoGroup.position.y -= deltaY * 0.015;
        } else if (interactionMode === 'rotate') {
            photoGroup.rotation.y += deltaX * 0.01; // 左右滑動控制 Yaw
            photoGroup.rotation.x += deltaY * 0.01; // 上下滑動控制 Pitch
        }

        previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && initialPinchDistance) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        const pinchScale = distance / initialPinchDistance;
        const rotateDiff = angle - initialPinchAngle;

        const s = initialScale * pinchScale;
        photoGroup.scale.set(s, s, s);
        photoGroup.rotation.z = initialRotation - rotateDiff; // 雙指控制畫面平面的旋轉 (Roll)
    }
}

function onTouchEnd(e) {
    isDragging = false;
    initialPinchDistance = null;
    initialPinchAngle = null;
}

// ----------------------------------------------------
// 電腦版滑鼠與滾輪支援 (映射至 Touch 邏輯)
// ----------------------------------------------------
function onMouseDown(e) {
    if (!photoGroup) return;
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
}

function onMouseMove(e) {
    if (!photoGroup || !isDragging) return;

    const deltaX = e.clientX - previousMousePosition.x;
    const deltaY = e.clientY - previousMousePosition.y;

    if (interactionMode === 'move') {
        photoGroup.position.x += deltaX * 0.015;
        photoGroup.position.y -= deltaY * 0.015;
    } else if (interactionMode === 'rotate') {
        photoGroup.rotation.y += deltaX * 0.01;
        photoGroup.rotation.x += deltaY * 0.01;
    }

    previousMousePosition = { x: e.clientX, y: e.clientY };
}

function onMouseUp(e) {
    isDragging = false;
}

function onMouseWheel(e) {
    e.preventDefault();
    if (!photoGroup) return;

    // 滾輪向前 (deltaY < 0) 放大，向後縮小
    const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
    photoGroup.scale.multiplyScalar(scaleFactor);
}
// ----------------------------------------------------

function takePhotoScreenshot() {
    if (!photoRenderer) return;
    photoRenderer.render(photoScene, photoCamera);

    // 預設將整個 canvas 交出，但如果因為比例問題有上下或左右黑邊，我們記錄實際的繪製區域邊界
    const canvas = document.createElement('canvas');
    canvas.width = photoRenderer.domElement.width;
    canvas.height = photoRenderer.domElement.height;
    const ctx = canvas.getContext('2d');

    // 紀錄實體照片的繪製範圍，供浮水印使用 (預設為全畫面)
    let contentRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };

    // 如果是即時相機模式，先將影片進度畫在底層，再疊加透明畫布
    if (liveVideoElement && liveVideoElement.readyState >= 2) {
        const videoRatio = liveVideoElement.videoWidth / liveVideoElement.videoHeight;
        const canvasRatio = canvas.width / canvas.height;
        let drawW, drawH, drawX, drawY;

        if (videoRatio > canvasRatio) {
            // 影片較寬，會有上下黑邊
            drawH = canvas.height;
            drawW = canvas.height * videoRatio;
            drawX = (canvas.width - drawW) / 2;
            drawY = 0;
            contentRect = { x: drawX, y: 0, w: drawW, h: canvas.height };
        } else {
            // 畫布較寬，會有左右黑邊
            drawW = canvas.width;
            drawH = canvas.width / videoRatio;
            drawX = 0;
            drawY = (canvas.height - drawH) / 2;
            contentRect = { x: 0, y: drawY, w: canvas.width, h: drawH };
        }
        ctx.drawImage(liveVideoElement, drawX, drawY, drawW, drawH);
    } else {
        // photo模式 (原生 HTML img 背景)
        const bgImg = document.getElementById("native-photo-bg");
        if (bgImg && bgImg.src) {
            const imgRatio = bgImg.naturalWidth / bgImg.naturalHeight;
            const canvasRatio = canvas.width / canvas.height;

            let drawW, drawH, drawX, drawY;
            if (imgRatio > canvasRatio) {
                // 原圖較寬，上下留黑邊 (對齊寬幅)
                drawW = canvas.width;
                drawH = canvas.width / imgRatio;
                drawX = 0;
                drawY = (canvas.height - drawH) / 2;
                contentRect = { x: 0, y: drawY, w: canvas.width, h: drawH };
            } else {
                // 原圖較長，左右留黑邊 (對齊高幅)
                drawH = canvas.height;
                drawW = canvas.height * imgRatio;
                drawX = (canvas.width - drawW) / 2;
                drawY = 0;
                contentRect = { x: drawX, y: 0, w: drawW, h: canvas.height };
            }
            ctx.drawImage(bgImg, drawX, drawY, drawW, drawH);
        }
    }

    ctx.drawImage(photoRenderer.domElement, 0, 0);

    finishAndDownload(canvas, contentRect, `合成場勘_${siteName}`);
}

function finishAndDownload(canvas, contentRect, fileNamePrefix) {
    // 截切圖片 (把黑邊裁掉) 回傳精確的實際合成圖
    let finalCanvas = canvas;

    // 1. 如果影片比例跟螢幕相差太大，我們只匯出真正的影像區域
    if (contentRect.w !== canvas.width || contentRect.h !== canvas.height) {
        // 因可能超出邊界，做個安全裁切：
        const clipX = Math.max(0, contentRect.x);
        const clipY = Math.max(0, contentRect.y);
        const clipW = Math.min(canvas.width, contentRect.w);
        const clipH = Math.min(canvas.height, contentRect.h);

        finalCanvas = document.createElement('canvas');
        finalCanvas.width = clipW;
        finalCanvas.height = clipH;
        finalCanvas.getContext('2d').drawImage(canvas, clipX, clipY, clipW, clipH, 0, 0, clipW, clipH);
    }

    // 2. 將浮水印壓印在「最終裁切」後的照片上
    const finalCtx = finalCanvas.getContext('2d');
    const padding = 20 * window.devicePixelRatio;
    const fontSize = 17 * window.devicePixelRatio;

    finalCtx.font = `bold ${fontSize}px sans-serif`;
    finalCtx.textAlign = 'right';
    finalCtx.textBaseline = 'bottom';

    finalCtx.shadowColor = "rgba(0, 0, 0, 0.8)";
    finalCtx.shadowBlur = 4 * window.devicePixelRatio;
    finalCtx.shadowOffsetX = 1 * window.devicePixelRatio;
    finalCtx.shadowOffsetY = 1 * window.devicePixelRatio;
    finalCtx.fillStyle = '#ffffff';

    const now = new Date().toLocaleString();
    const watermarkLines = [`站點: ${siteName}`, `GPS: ${gpsData.lat}, ${gpsData.lng}`, now];

    // 在最終確定好的實體長寬 (finalCanvas.width/height) 右下角畫浮水印
    watermarkLines.reverse().forEach((text, i) => {
        finalCtx.fillText(text, finalCanvas.width - padding - 10, finalCanvas.height - padding - 15 - (i * (fontSize + 6 * window.devicePixelRatio)));
    });
    finalCtx.shadowColor = "transparent";

    const dataURL = finalCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `${fileNamePrefix}_${Date.now()}.png`;
    a.click();

    // 截圖後顯示完成面板，將控制列與 UI 隱藏，不銷毀場景以保留背景
    document.getElementById('post-ar-ui').classList.remove('hidden');
    document.getElementById('photo-ar-ui').classList.add('hidden');
    document.getElementById('ar-ui').classList.add('hidden');
}
