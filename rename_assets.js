const fs = require('fs');
const path = require('path');

const modelsDir = 'C:\\Users\\USER\\.gemini\\antigravity\\playground\\webxr-survey-app\\assets\\models';

const folderMap = {
    'Ai4-免換袋1.8_W180.3 x H220 x D112.9': 'm01_ai4_18',
    'Ai4-免換袋2.1_W208.3 x H220 x D112.9': 'm02_ai4_21',
    'Ai4-免換袋2.7_W268.3x H220 x D118': 'm03_ai4_27',
    'Ai4-單機+瓶蓋箱__W111.5 x H190 x D93': 'm04_ai4_cap',
    'H30_W140 x H205 x D90.8': 'm05_h30',
    '全聯Ai4-免換袋1.8_W180.3 x H220 x D112.9': 'm06_px_ai4_18',
    '全聯Ai4-免換袋2.1_W208.3 x H220 x D112.9': 'm07_px_ai4_21',
    '全聯Ai4-免換袋2.7_W268.3x H220 x D118': 'm08_px_ai4_27',
    '全聯Ai4-單機+瓶蓋箱__W111.5 x H190 x D93(含瓶蓋箱)': 'm09_px_ai4_cap',
    '台塑便利家v1-洗寶_W85 x H180 x D67': 'm10_formosa_v1',
    '台塑便利家v2-水精靈_W88 x H190 x D85': 'm11_formosa_v2',
    '特力屋_W268.3x H220 x D118': 'm12_tlw',
    '電池機v2_W41 x H162.3 x D47.8': 'm13_battery_v2',
    '電池機v3-室內版_W41 x H175 x D34': 'm14_battery_v3_in',
    '電池機v3-室外版_W41 x H175 x D34': 'm15_battery_v3_out'
};

if (!fs.existsSync(modelsDir)) {
    console.error('Directory not found:', modelsDir);
    process.exit(1);
}

const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
for (const entry of entries) {
    if (entry.isDirectory() && folderMap[entry.name]) {
        const oldDirPath = path.join(modelsDir, entry.name);
        const newDirPath = path.join(modelsDir, folderMap[entry.name]);

        fs.renameSync(oldDirPath, newDirPath);
        console.log(`Renamed folder: ${entry.name} -> ${folderMap[entry.name]}`);

        const files = fs.readdirSync(newDirPath);
        for (const file of files) {
            if (file.endsWith('.png')) {
                let newFile = null;
                // 利用檔名中的關鍵字對應
                if (file.includes('左')) newFile = 'left.png';
                else if (file.includes('右')) newFile = 'right.png';
                else if (file.includes('正')) newFile = 'front.png';
                else if (file.includes('背')) newFile = 'back.png';
                else newFile = 'front.png'; // 預設為正面

                if (newFile) {
                    const oldFilePath = path.join(newDirPath, file);
                    let finalFilePath = path.join(newDirPath, newFile);

                    // 避免同名覆蓋
                    let counter = 1;
                    while (fs.existsSync(finalFilePath) && oldFilePath !== finalFilePath) {
                        finalFilePath = path.join(newDirPath, newFile.replace('.png', `_${counter}.png`));
                        counter++;
                    }
                    if (oldFilePath !== finalFilePath) {
                        fs.renameSync(oldFilePath, finalFilePath);
                        console.log(`  Renamed file: ${file} -> ${path.basename(finalFilePath)}`);
                    }
                }
            }
        }
    }
}
console.log('Done renaming assets.');
