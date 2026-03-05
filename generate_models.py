import os
import re

models_dir = r"C:\Users\USER\.gemini\antigravity\playground\webxr-survey-app\assets\models"
dirs = [d for d in os.listdir(models_dir) if os.path.isdir(os.path.join(models_dir, d))]

def get_group_name(dname):
    if dname.startswith('Ai4-免換袋'): return 'Ai4-免換袋'
    if dname.startswith('Ai4-單機+瓶蓋箱'): return 'Ai4-單機+瓶蓋箱'
    if dname.startswith('全聯Ai4-免換袋'): return '全聯Ai4-免換袋'
    if dname.startswith('全聯Ai4-單機+瓶蓋箱'): return '全聯Ai4-單機+瓶蓋箱'
    if dname.startswith('台塑便利家'): return '台塑便利家'
    if dname.startswith('電池機'): return '電池機'
    if dname.startswith('H30'): return 'H30'
    if dname.startswith('特力屋'): return '特力屋'
    return '其他'

groups = {}
for d in dirs:
    group = get_group_name(d)
    if group not in groups:
        groups[group] = []
        
    match_w = re.search(r'W(\d+(\.\d+)?)', d)
    match_h = re.search(r'H(\d+(\.\d+)?)', d)
    w = match_w.group(1) if match_w else '100'
    h = match_h.group(1) if match_h else '200'
    
    sub = d.split('_')[0].replace(group, '')
    if not sub: sub = '標準'
    
    files = os.listdir(os.path.join(models_dir, d))
    pngs = [f for f in files if f.endswith('.png')]
    selected_png = next((f for f in pngs if '正' in f), pngs[0] if pngs else '')
    if not selected_png and pngs:
        # Fallback for when '正' is not in the name
        selected_png = next((f for f in pngs if 'V4.png' in f and '左' not in f and '右' not in f), pngs[0])
    
    if selected_png:
        groups[group].append({
            'sub': sub,
            'w': w,
            'h': h,
            'img': f'./assets/models/{d}/{selected_png}'
        })

html = ''
for group, models in groups.items():
    html += f'        <details class="model-group">\n'
    html += f'          <summary>{group}</summary>\n'
    html += f'          <div class="model-group-content">\n'
    for m in models:
        html += f'            <label><input type="checkbox" value="{group}-{m["sub"]}" data-w="{m["w"]}" data-h="{m["h"]}" data-img="{m["img"]}"> {m["sub"]}</label>\n'
    html += f'          </div>\n'
    html += f'        </details>\n'

with open('generated_ui.txt', 'w', encoding='utf-8') as f:
    f.write(html)
print('Done!')
