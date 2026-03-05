const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, 'assets', 'models');
const dirs = fs.readdirSync(modelsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

let html = '';
let currentGroup = '';

// Helper to group name
function getGroupName(dirName) {
    if (dirName.startsWith('Ai4-免換袋')) return 'Ai4-免換袋';
    if (dirName.startsWith('Ai4-單機+瓶蓋箱')) return 'Ai4-單機+瓶蓋箱';
    if (dirName.startsWith('全聯Ai4-免換袋')) return '全聯Ai4-免換袋';
    if (dirName.startsWith('全聯Ai4-單機+瓶蓋箱')) return '全聯Ai4-單機+瓶蓋箱';
    if (dirName.startsWith('台塑便利家')) return '台塑便利家';
    if (dirName.startsWith('電池機')) return '電池機';
    if (dirName.startsWith('H30')) return 'H30';
    if (dirName.startsWith('特力屋')) return '特力屋';
    return '其他';
}

function parseInfo(dirName) {
    // try to get W, H
    const match = dirName.match(/_W([\d\.]+).*?H([\d\.]+)/i);
    let w = match ? match[1] : 100;
    let h = match ? match[2] : 200;

    // try to get sub name
    let sub = dirName.split('_')[0].replace(getGroupName(dirName), '');
    if (!sub) sub = '標準';

    return { w, h, sub };
}

let groups = {};
dirs.forEach(dir => {
    let group = getGroupName(dir);
    if (!groups[group]) groups[group] = [];

    let info = parseInfo(dir);
    // Find first png
    let files = fs.readdirSync(path.join(modelsDir, dir));
    let pngs = files.filter(f => f.endsWith('.png'));
    let selectedPng = pngs.find(f => f.includes('正')) || pngs[0];

    if (selectedPng) {
        groups[group].push({
            sub: info.sub,
            w: info.w,
            h: info.h,
            img: `./assets/models/${dir}/${selectedPng}`
        });
    }
});

for (let group in groups) {
    html += `        <details class="model-group">\n`;
    html += `          <summary>${group}</summary>\n`;
    html += `          <div class="model-group-content">\n`;
    groups[group].forEach(model => {
        html += `            <label><input type="checkbox" value="${group}-${model.sub}" data-w="${model.w}" data-h="${model.h}" data-img="${model.img}"> ${model.sub}</label>\n`;
    });
    html += `          </div>\n`;
    html += `        </details>\n`;
}

console.log(html);
fs.writeFileSync('generated_ui.txt', html);
