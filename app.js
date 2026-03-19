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

// 透視畫線全域變數
let currentRealWidth = 1;
let currentRealDepth = 1;
let drawState = 0; // 0: none, 1: drawing W, 2: drawing D, 3: drawing H
let p_w1 = null, p_w2 = null, p_d1 = null, p_d2 = null, p_h1 = null, p_h2 = null;

// ------------------------------------------------------------------
// 1. 初始化介面與 GPS API
// ------------------------------------------------------------------
// ---- 全域的圖片輸入參考 ----
let importInputRef = null;

// ---- 全域的場景重繪函式 ----
function rebuildModelGroup() {
    if (!photoGroup) return;
    while (photoGroup.children.length > 0) {
        photoGroup.remove(photoGroup.children[0]);
    }
    let totalWidth = 0;
    let maxDepth = 0.5; // fallback
    selectedModels.forEach(modelDef => {
        totalWidth += modelDef.w;
        if (modelDef.hasCap) totalWidth += modelDef.capW;
        if (modelDef.d > maxDepth) maxDepth = modelDef.d;
        if (modelDef.hasCap && modelDef.capD > maxDepth) maxDepth = modelDef.capD;
    });
    totalWidth += (selectedModels.length - 1) * 0.1;
    
    currentRealWidth = totalWidth || 1;
    currentRealDepth = maxDepth || 1;
    
    let currentX = -totalWidth / 2;
    selectedModels.forEach((modelDef) => {
        const machine = createMachine3D(modelDef);
        const unitWidth = modelDef.w + (modelDef.hasCap ? modelDef.capW : 0);
        machine.position.set(currentX + modelDef.w / 2, -1, 1 - (modelDef.d / 2));
        photoGroup.add(machine);
        currentX += unitWidth + 0.1;
    });
}

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
            (err) => { gpsStatus.textContent = `無法取得 GPS (${err.message})`; },
            { enableHighAccuracy: true }
        );
    } else {
        gpsStatus.textContent = "瀏覽器不支援 GPS";
    }

    setTimeout(() => {
        if (gpsStatus.textContent === "等待授權中...") {
            gpsStatus.textContent = "等待授權中 (請注意瀏覽器權限提示)";
        }
    }, 3000);

    document.getElementById('site-name').addEventListener('input', (e) => {
        siteName = e.target.value || '未命名站點';
        document.getElementById('wm-site').textContent = `站點: ${siteName}`;
    });

    document.getElementById('btn-shutter').addEventListener('click', takeScreenshot);

    // ---- 先宣告 importInput，讓後面所有監聽器都能用 ----
    const importInput = document.getElementById('image-upload');
    importInputRef = importInput; // 存入全域供其他函式使用

    // ---- 繼續拍攝 (同機型) ----
    document.getElementById('btn-continue').addEventListener('click', () => {
        document.getElementById('post-ar-ui').classList.add('hidden');

        // 位置重置
        if (photoGroup) {
            photoGroup.position.set(0, 0, 0);
            photoGroup.rotation.set(0, 0, initialRotation || 0);
            photoGroup.scale.set(1, 1, 1);
        }

        // 重新顯示操作層
        if (currentARMode === 'photo_import' || currentARMode === 'live_video') {
            document.getElementById('photo-ar-ui').classList.remove('hidden');
        } else {
            document.getElementById('ar-ui').classList.remove('hidden');
        }

        // 照片匯入模式：自動彈出選片 (需在顯示 UI 後執行，確保在 user gesture 鏈中)
        if (currentARMode === 'photo_import') {
            setTimeout(() => importInput.click(), 50);
        }
    });

    document.getElementById('btn-restart').addEventListener('click', () => {
        window.location.reload();
    });

    // ---- prepareModels ----
    function prepareModels() {
        const checkboxes = document.querySelectorAll('#model-list input.machine-check:checked');
        if (checkboxes.length === 0) {
            alert("請至少先選擇一個機型");
            return false;
        }
        selectedModels = Array.from(checkboxes).map(cb => {
            const capCheckbox = cb.parentElement.nextElementSibling?.querySelector('.cap-check');
            const askForCap = capCheckbox ? capCheckbox.checked : false;
            return {
                w: parseFloat(cb.dataset.w) / 100,
                h: parseFloat(cb.dataset.h) / 100,
                d: (parseFloat(cb.dataset.d) || 50) / 100,
                color: cb.dataset.color || '#888888',
                img: cb.dataset.img,
                imgL: cb.dataset.imgL || null,
                imgR: cb.dataset.imgR || null,
                imgB: cb.dataset.imgB || null,
                imgT: cb.dataset.imgT || null,
                hasCap: (cb.dataset.capW !== undefined) && askForCap,
                capW: parseFloat(cb.dataset.capW) / 100 || 0,
                capH: parseFloat(cb.dataset.capH) / 100 || 0,
                capD: parseFloat(cb.dataset.capD) / 100 || 0,
                capImg: cb.dataset.capImg || null,
                capImgL: cb.dataset.capImgL || null,
                capImgR: cb.dataset.capImgR || null,
                capImgB: cb.dataset.capImgB || null,
                capImgT: cb.dataset.capImgT || null
            };
        });
        return true;
    }

    // ---- 查看尺寸按鈕 ----
    document.getElementById('btn-view-dimensions').addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('#model-list input.machine-check:checked');
        if (checkboxes.length === 0) { alert("請先勾選您想查詢的機台！"); return; }

        let msg = "您選擇的機台尺寸如下 (單位: cm)：\n\n";
        let totalW = 0, maxD = 0;
        const spacing = 10;

        Array.from(checkboxes).forEach((cb, index) => {
            const name = cb.parentElement.textContent.trim();
            const w = parseFloat(cb.dataset.w);
            const h = parseFloat(cb.dataset.h);
            const d = parseFloat(cb.dataset.d || "50");
            let cUnitW = w, cUnitD = d;

            msg += `• [${name}]: ${w} x ${d} x ${h}\n`;

            const capCb = cb.parentElement.nextElementSibling?.querySelector('.cap-check');
            if (capCb && capCb.checked && cb.dataset.capW) {
                const cw = parseFloat(cb.dataset.capW);
                const cd = parseFloat(cb.dataset.capD);
                const ch = parseFloat(cb.dataset.capH);
                msg += `  ↳ (+ 瓶蓋箱): ${cw} x ${cd} x ${ch}\n`;
                cUnitW += cw;
                if (cd > cUnitD) cUnitD = cd;
            }
            totalW += cUnitW;
            if (cUnitD > maxD) maxD = cUnitD;
            if (index < checkboxes.length - 1) totalW += spacing;
        });

        msg += `\n----------------------\n`;
        msg += `📏 預估佔用總寬度: ${totalW.toFixed(1)} cm (含 10cm 間隙)\n`;
        msg += `📐 預估最大進深: ${maxD.toFixed(1)} cm\n`;
        alert(msg);
    });

    // ---- 匯入舊照 (手機版直接 click file input) ----
    document.getElementById('btn-photo-import').addEventListener('click', () => {
        if (prepareModels()) {
            importInput.click();
        }
    });

    // ---- 立即拍照 ----
    document.getElementById('btn-photo-capture').addEventListener('click', () => {
        if (prepareModels()) startLiveVideoMode();
    });

    importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                fixImageOrientation(event.target.result, (fixedBase64) => {
                    startPhotoARMode(fixedBase64);
                });
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });

    function fixImageOrientation(base64Image, callback) {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            let targetW = img.naturalWidth;
            let targetH = img.naturalHeight;
            const MAX_SIZE = 2560;
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

    // 變換機台順序 (全局級綁定，确保 AR 模式啟動前後都有效)
    document.getElementById('btn-reorder-models')?.addEventListener('click', () => {
        if (selectedModels.length <= 1) return;
        const first = selectedModels.shift();
        selectedModels.push(first);
        rebuildModelGroup();
    });

    setInterval(() => {
        const now = new Date();
        const t = now.toLocaleString();
        const a = document.getElementById('wm-time');
        const b = document.getElementById('photo-wm-time');
        if (a) a.textContent = t;
        if (b) b.textContent = t;
    }, 1000);

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
        const checkboxes = document.querySelectorAll('#model-list input.machine-check:checked');
        if (checkboxes.length === 0) {
            alert("請至少選擇一個機型");
            // 注意：進入 AR 畫面後無法隨意中止，故僅作提醒
        }
        
        selectedModels = Array.from(checkboxes).map(cb => {
            const capCheckbox = cb.parentElement.nextElementSibling?.querySelector('.cap-check');
            const askForCap = capCheckbox ? capCheckbox.checked : false;

            return {
                w: parseFloat(cb.dataset.w) / 100,
                h: parseFloat(cb.dataset.h) / 100,
                d: (parseFloat(cb.dataset.d) || 50) / 100,
                color: cb.dataset.color || '#888888',
                img: cb.dataset.img,
                imgL: cb.dataset.imgL || null,
                imgR: cb.dataset.imgR || null,
                imgB: cb.dataset.imgB || null,
                imgT: cb.dataset.imgT || null,
                
                hasCap: (cb.dataset.capW !== undefined) && askForCap,
                capW: parseFloat(cb.dataset.capW) / 100 || 0,
                capH: parseFloat(cb.dataset.capH) / 100 || 0,
                capD: parseFloat(cb.dataset.capD) / 100 || 0,
                capImg: cb.dataset.capImg || null,
                capImgL: cb.dataset.capImgL || null,
                capImgR: cb.dataset.capImgR || null,
                capImgB: cb.dataset.capImgB || null,
                capImgT: cb.dataset.capImgT || null
            };
        });
        
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
    const group = new THREE.Group();
    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');
    const themeColor = new THREE.Color(modelDef.color);

    // --- 1. 建立主體機身 ---
    const mainMaterials = [];
    const mainFaceConfigs = [
        { key: 'imgR', fallback: modelDef.img }, // 右
        { key: 'imgL', fallback: modelDef.img }, // 左
        { key: 'imgT', color: themeColor },      // 上
        { key: null, color: themeColor },        // 下
        { key: 'img', fallback: modelDef.img },  // 正
        { key: 'imgB', color: themeColor }       // 背
    ];

    mainFaceConfigs.forEach((config) => {
        const path = config.key ? (modelDef[config.key] || config.fallback) : null;
        if (path) {
            const texture = textureLoader.load(path);
            texture.colorSpace = THREE.SRGBColorSpace;
            mainMaterials.push(new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                alphaTest: 0.1
            }));
        } else {
            mainMaterials.push(new THREE.MeshBasicMaterial({ color: config.color }));
        }
    });

    const mainGeo = new THREE.BoxGeometry(modelDef.w, modelDef.h, modelDef.d);
    mainGeo.translate(0, modelDef.h / 2, 0);
    const mainMesh = new THREE.Mesh(mainGeo, mainMaterials);
    group.add(mainMesh);

    // --- 2. 建立瓶蓋箱配件 (如果有的話) ---
    if (modelDef.hasCap && modelDef.capImg) {
        const capMaterials = [];
        const capFaceConfigs = [
            { key: 'capImgR', fallback: modelDef.capImg }, // 右
            { key: 'capImgL', fallback: modelDef.capImg }, // 左
            { key: 'capImgT', color: themeColor },         // 上
            { key: null, color: themeColor },              // 下
            { key: 'capImg', fallback: modelDef.capImg },  // 正
            { key: 'capImgB', color: themeColor }          // 背
        ];

        capFaceConfigs.forEach((config) => {
            const path = config.key ? (modelDef[config.key] || config.fallback) : null;
            if (path) {
                const texture = textureLoader.load(path);
                texture.colorSpace = THREE.SRGBColorSpace;
                capMaterials.push(new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.1 }));
            } else {
                capMaterials.push(new THREE.MeshBasicMaterial({ color: config.color }));
            }
        });

        const capGeo = new THREE.BoxGeometry(modelDef.capW, modelDef.capH, modelDef.capD);
        capGeo.translate(0, modelDef.capH / 2, 0);
        const capMesh = new THREE.Mesh(capGeo, capMaterials);
        
        // **關鍵：水平對齊與正面切齊**
        // 1. X 軸：主體右側
        capMesh.position.x = (modelDef.w / 2) + (modelDef.capW / 2);
        
        // 2. Z 軸：正面對齊 (Front Face Alignment)
        // BoxGeometry 的 Z 軸中心在 0, 正面在 +D/2, 背面在 -D/2
        // 要讓配件正面對齊主體正面：
        // 配件正面 Z = capMesh.position.z + (capD / 2)
        // 主體正面 Z = 0 + (mainD / 2)
        // 令兩者相等 => capMesh.position.z = (modelDef.d / 2) - (modelDef.capD / 2)
        capMesh.position.z = (modelDef.d / 2) - (modelDef.capD / 2);
        
        group.add(capMesh);
    }

    return group;
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

        // 移除強制翻轉機台的 checkIsLandscape 邏輯，
        // 因為照片在匯入時就應該是正的，強迫翻轉會導致使用者在橫屏看相片時機台變成平躺。
        if (photoGroup) {
            photoGroup.rotation.z = 0;
            initialRotation = 0;
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
    // 關閉時清除背景
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
        photoRenderer.dispose(); // 徹底釋放 GPU 資源
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
    photoScene = null;
    photoCamera = null;
}

function startCommonARMode() {
    document.getElementById('setup-ui').classList.add('hidden');
    document.getElementById('photo-ar-ui').classList.remove('hidden');

    // ---- 關鍵修復：場景重用檢查 ----
    let container = document.getElementById('photo-ar-container');
    if (container) {
        // 如果已經有容器，代表是「繼續拍攝」，我們不重複創建 Renderer 與場景
        // 只需要清空背景內容即可
        if (liveVideoElement) {
            liveVideoElement.remove();
            liveVideoElement = null;
        }
        if (localVideoStream) {
            localVideoStream.getTracks().forEach(track => track.stop());
            localVideoStream = null;
        }
        const bgImg = document.getElementById("native-photo-bg");
        if (bgImg) { bgImg.src = ""; bgImg.classList.add('hidden'); }

        // 重設群組變換
        if (photoGroup) {
            photoGroup.position.set(0, 0, 0);
            photoGroup.scale.set(1, 1, 1);
            photoGroup.rotation.set(0, 0, initialRotation || 0);
        }
        rebuildModelGroup();
        return; 
    }

    // 若無容器，則是第一次啟動
    container = document.createElement('div');
    container.id = 'photo-ar-container';
    container.style.position = 'fixed';
    container.style.top = '0'; container.style.left = '0';
    container.style.width = '100vw'; container.style.height = '100vh';
    container.style.zIndex = '5';
    container.style.touchAction = 'none'; 
    document.body.appendChild(container);

    photoScene = new THREE.Scene();
    // 還原為正常手機相機的自然透視視角 (FOV=70)，消除「不自然的梯形」逆透視盲區錯覺
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
    const btnPerspective = document.getElementById('btn-mode-perspective');
    
    interactionMode = 'move';

    function setMode(mode) {
        interactionMode = mode;
        btnMove.classList.remove('highlight');
        btnRotate.classList.remove('highlight');
        if (btnPerspective) btnPerspective.classList.remove('highlight');
        
        if (mode === 'move') btnMove.classList.add('highlight');
        else if (mode === 'rotate') btnRotate.classList.add('highlight');
        else if (mode === 'perspective') btnPerspective.classList.add('highlight');

        // 如果退出畫線透視模式，隱藏提示與輔助線
        if (mode !== 'perspective') {
            drawState = 0;
            const ids = ['line-width', 'line-depth', 'line-height', 'draw-anchor'];
            ids.forEach(id => {
                let el = document.getElementById(id);
                if (el) el.setAttribute('visibility', 'hidden');
            });
            const hint = document.getElementById('perspective-hint');
            if (hint) hint.classList.add('hidden');
        }
    }

    btnMove.onclick = () => setMode('move');
    btnRotate.onclick = () => setMode('rotate');

    if (btnPerspective) {
        btnPerspective.onclick = () => {
            if (interactionMode === 'perspective') {
                setMode('move'); // toggle off
            } else {
                setMode('perspective');
                drawState = 1;
                const hint = document.getElementById('perspective-hint');
                if (hint) {
                    hint.textContent = '請在機台底部某一角落，拖曳出【寬度線】(例如向右拉)';
                    hint.classList.remove('hidden');
                }
            }
        };
    }

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

    // 初始進入時執行一次繪製
    rebuildModelGroup();

    // 初始進入時將旋轉歸零
    photoGroup.rotation.z = 0;
    initialRotation = 0;

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
                    // 照片已經由 navigator.mediaDevices 與 CSS cover 自動妥善排版
                    // 不再強制將 3D 群組打橫，確保使用者看到的畫面跟 3D 空間視角正交
                    photoGroup.rotation.z = 0;
                    initialRotation = 0;
                }
            };
        })
        .catch(err => {
            alert("相機授權失敗或不支援，請改用「從相簿匯入舊照」模式。(" + err.message + ")");
            window.location.reload();
        });
}

// ----------------------------------------------------
// 透視對齊輔助函式與核心數學運算
// ----------------------------------------------------
function getEventCoords(e) {
    if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
}

function updateLineSVG(id, p1, p2) {
    const line = document.getElementById(id);
    if (!line) return;
    line.setAttribute('x1', p1.x);
    line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x);
    line.setAttribute('y2', p2.y);
    line.setAttribute('visibility', 'visible');
}

// 直線交點公式
function getIntersection(a1, a2, b1, b2) {
    const denom = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
    if (Math.abs(denom) < 0.0001) return null; // 平行
    const ix = ((a1.x * a2.y - a1.y * a2.x) * (b1.x - b2.x) - (a1.x - a2.x) * (b1.x * b2.y - b1.y * b2.x)) / denom;
    const iy = ((a1.x * a2.y - a1.y * a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x * b2.y - b1.y * b2.x)) / denom;
    return { x: ix, y: iy };
}

function applyPerspectiveTransform(pw1, pw2, pd1, pd2, ph1, ph2) {
    if (!photoGroup || !photoCamera) return;

    // 1. 計算交點 (Anchor) — 寬線與深度線延伸後的交叉點
    let anchor_O = getIntersection(pw1, pw2, pd1, pd2);
    if (!anchor_O) anchor_O = pw1;

    // 取得寬度線「遠端」點（相對 Anchor 最遠的那一端）
    let dW1 = Math.hypot(pw1.x - anchor_O.x, pw1.y - anchor_O.y);
    let dW2 = Math.hypot(pw2.x - anchor_O.x, pw2.y - anchor_O.y);
    let pW = (dW1 > dW2) ? pw1 : pw2;

    let dD1 = Math.hypot(pd1.x - anchor_O.x, pd1.y - anchor_O.y);
    let dD2 = Math.hypot(pd2.x - anchor_O.x, pd2.y - anchor_O.y);
    let pD = (dD1 > dD2) ? pd1 : pd2;

    updateLineSVG('line-width', anchor_O, pW);
    updateLineSVG('line-depth', anchor_O, pD);

    // wLen 改在步驟3計算（用 pw1/pw2 全長）

    // 2. 由高度線判斷手機方向 → 鎖定 Y=0（直向）或 Y=90（橫向）
    let vh = { x: ph2.x - ph1.x, y: ph2.y - ph1.y };
    let yaw = 0;
    if (Math.hypot(vh.x, vh.y) > 10) {
        let hAngleDeg = Math.abs(Math.atan2(vh.x, -vh.y) * 180 / Math.PI);
        if (hAngleDeg > 45) yaw = Math.PI / 2;
    }
    photoGroup.rotation.set(0, yaw, 0);

    // 3. 計算螢幕像素/3D 單位換算比 (基於相機 FOV 與距離)
    // 相機坐標系：camera 在 (0,0,8)，FOV=70，正面 front 在 Z=0（group Z=0，local front Z=1→world Z=0）
    // 機台前面的世界 Z = group.position.z + 1*scale ≒ 0
    // 所以我們假設前面在 z=0，算出正確的世界尺寸
    let fovRad = THREE.MathUtils.degToRad(photoCamera.fov);
    let cameraZ = photoCamera.position.z; // =8
    let frontZ = 0;                       // 機台前面假設放在世界 Z=0
    let distToFront = cameraZ - frontZ;   // =8

    // 螢幕高度對應 3D 世界高度 (在 frontZ 平面)
    let worldHeightAtFront = 2 * distToFront * Math.tan(fovRad / 2);
    let pixPerUnit = window.innerHeight / worldHeightAtFront; // 像素/3D 單位

    // 寬度線的完整螢幕像素長度（pw1 到 pw2）
    let wLen = Math.hypot(pw2.x - pw1.x, pw2.y - pw1.y);
    if (wLen < 5) return;

    // 3D 縮放 = 像素長度 ÷ 像素/單位 ÷ 機台實際寬度
    let modelScale = (wLen / pixPerUnit) / currentRealWidth;
    photoGroup.scale.set(modelScale, modelScale, modelScale);

    // 4. 寬度線中點的螢幕位置 → 對應 3D 世界座標 (在 frontZ 平面)
    let midScreen = { x: (pw1.x + pw2.x) / 2, y: (pw1.y + pw2.y) / 2 };
    
    function screenToWorld(p, worldZ) {
        let ndcX = (p.x / window.innerWidth) * 2 - 1;
        let ndcY = -(p.y / window.innerHeight) * 2 + 1;
        // 透視投影：worldX = ndcX * distToTarget * tan(fovH/2)
        let aspect = window.innerWidth / window.innerHeight;
        let halfFovH = Math.atan(Math.tan(fovRad / 2) * aspect);
        let dist = cameraZ - worldZ;
        let wx = ndcX * dist * Math.tan(halfFovH);
        let wy = ndcY * dist * Math.tan(fovRad / 2);
        return new THREE.Vector3(wx, wy, worldZ);
    }

    // 前底中心的世界位置 (frontZ=0 平面)
    let frontBottomCenter = screenToWorld(midScreen, frontZ);

    // 5. 機台 group 中心 = 前底中心 − localFrontBottom * scale
    //    localFrontBottom = (0, -1, 1)：front face 底部在 group local 的位置
    let localFrontBottom = new THREE.Vector3(0, -1, 1);
    let worldFrontOffset = localFrontBottom.clone().multiplyScalar(modelScale)
        .applyQuaternion(photoGroup.quaternion);

    photoGroup.position.copy(frontBottomCenter).sub(worldFrontOffset);
}





// ----------------------------------------------------
// 滑鼠與觸控共通處理邏輯
// ----------------------------------------------------
function handlePointerDown(e) {
    if (!photoGroup) return;

    if (interactionMode === 'perspective') {
        const p = getEventCoords(e);
        if (drawState === 1) {
            p_w1 = p; p_w2 = p;
            updateLineSVG('line-width', p_w1, p_w2);
        } else if (drawState === 2) {
            p_d1 = p; p_d2 = p;
            updateLineSVG('line-depth', p_d1, p_d2);
        } else if (drawState === 3) {
            p_h1 = p; p_h2 = p;
            updateLineSVG('line-height', p_h1, p_h2);
        }
        isDragging = true;
        if (e.cancelable) e.preventDefault();
        return;
    }

    if (e.type.startsWith('touch') && e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
        initialPinchAngle = Math.atan2(dy, dx);
        initialScale = photoGroup.scale.x;
        initialRotation = photoGroup.rotation.z; // 雙指平轉改為 Z 軸 rolling
    } else {
        isDragging = true;
        previousMousePosition = getEventCoords(e);
    }
}

function handlePointerMove(e) {
    if (!photoGroup) return;

    if (interactionMode === 'perspective' && isDragging) {
        if (e.cancelable) e.preventDefault();
        const p = getEventCoords(e);
        if (drawState === 1) {
            p_w2 = p;
            updateLineSVG('line-width', p_w1, p_w2);
        } else if (drawState === 2) {
            p_d2 = p;
            updateLineSVG('line-depth', p_d1, p_d2);
        } else if (drawState === 3) {
            p_h2 = p;
            updateLineSVG('line-height', p_h1, p_h2);
        }
        return;
    }

    if (!isDragging && (!e.touches || e.touches.length !== 2)) return;
    if (e.cancelable) e.preventDefault();

    if (isDragging) {
        const currentPos = getEventCoords(e);
        const deltaX = currentPos.x - previousMousePosition.x;
        const deltaY = currentPos.y - previousMousePosition.y;

        if (interactionMode === 'move') {
            photoGroup.position.x += deltaX * 0.015;
            photoGroup.position.y -= deltaY * 0.015;
        } else if (interactionMode === 'rotate') {
            photoGroup.rotation.y += deltaX * 0.01;
            photoGroup.rotation.x += deltaY * 0.01;
        }
        previousMousePosition = currentPos;
    } else if (e.touches && e.touches.length === 2 && initialPinchDistance) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        const pinchScale = distance / initialPinchDistance;
        const rotateDiff = angle - initialPinchAngle;

        const s = initialScale * pinchScale;
        photoGroup.scale.set(s, s, s);
        photoGroup.rotation.z = initialRotation - rotateDiff;
    }
}

function handlePointerUp(e) {
    if (!photoGroup) return;

    if (interactionMode === 'perspective' && isDragging) {
        isDragging = false;
        if (drawState === 1) {
            if (Math.hypot(p_w2.x - p_w1.x, p_w2.y - p_w1.y) < 20) {
                document.getElementById('line-width').setAttribute('visibility', 'hidden');
                return; 
            }
            drawState = 2;
            document.getElementById('perspective-hint').textContent = '請畫出機台側面的【深度線】(若沒碰在一起會自動延伸)';
        } else if (drawState === 2) {
            if (Math.hypot(p_d2.x - p_d1.x, p_d2.y - p_d1.y) < 20) {
                document.getElementById('line-depth').setAttribute('visibility', 'hidden');
                return;
            }
            drawState = 3;
            document.getElementById('perspective-hint').textContent = '請由下往上畫出機台【高度線】(辨識傾斜用)';
        } else if (drawState === 3) {
            if (Math.hypot(p_h2.x - p_h1.x, p_h2.y - p_h1.y) < 20) {
                document.getElementById('line-height').setAttribute('visibility', 'hidden');
                return;
            }
            document.getElementById('perspective-hint').classList.add('hidden');
            
            // 執行運算與轉換
            applyPerspectiveTransform(p_w1, p_w2, p_d1, p_d2, p_h1, p_h2);
            
            // 完成後自動切換回移動模式
            const btnMove = document.getElementById('btn-mode-move');
            if (btnMove) btnMove.click();
        }
        return;
    }

    isDragging = false;
    initialPinchDistance = null;
    initialPinchAngle = null;
}

function onTouchStart(e) { handlePointerDown(e); }
function onTouchMove(e) { handlePointerMove(e); }
function onTouchEnd(e) { handlePointerUp(e); }

function onMouseDown(e) { handlePointerDown(e); }
function onMouseMove(e) { handlePointerMove(e); }
function onMouseUp(e) { handlePointerUp(e); }


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

// ---- 正式啟動程式 ----
initUI();
initThree();
