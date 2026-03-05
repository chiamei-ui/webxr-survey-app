import os
import shutil

# 定義目標資料夾路徑
base_dir = r"C:\Users\USER\.gemini\antigravity\playground\webxr-survey-app\assets\models"

# 建立中文字與英文的對應表
# 這樣我們就能將中文資料夾安全地重新命名為純英文
folder_mapping = {
    "Ai4-免換袋1.8_W180.3 x H220 x D112.9": "m01_ai4_18",
    "Ai4-免換袋2.1_W208.3 x H220 x D112.9": "m02_ai4_21",
    "Ai4-免換袋2.7_W268.3x H220 x D118": "m03_ai4_27",
    "Ai4-單機+瓶蓋箱__W111.5 x H190 x D93": "m04_ai4_cap",
    "H30_W140 x H205 x D90.8": "m05_h30",
    "全聯Ai4-免換袋1.8_W180.3 x H220 x D112.9": "m06_px_ai4_18",
    "全聯Ai4-免換袋2.1_W208.3 x H220 x D112.9": "m07_px_ai4_21",
    "全聯Ai4-免換袋2.7_W268.3x H220 x D118": "m08_px_ai4_27",
    "全聯Ai4-單機+瓶蓋箱__W111.5 x H190 x D93(含瓶蓋箱)": "m09_px_ai4_cap",
    "台塑便利家v1-洗寶_W85 x H180 x D67": "m10_formosa_v1",
    "台塑便利家v2-水精靈_W88 x H190 x D85": "m11_formosa_v2",
    "特力屋_W268.3x H220 x D118": "m12_tlw",
    "電池機v2_W41 x H162.3 x D47.8": "m13_battery_v2",
    "電池機v3-室內版_W41 x H175 x D34": "m14_battery_v3_in",
    "電池機v3-室外版_W41 x H175 x D34": "m15_battery_v3_out"
}

def clean_file_name(file_name, directory):
    """
    依照圖檔名稱內容重新命名為 front.png, left.png, right.png
    """
    if file_name.endswith('.png'):
        new_name = None
        lower_name = file_name.lower()
        if "左" in lower_name:
            new_name = "left.png"
        elif "右" in lower_name:
            new_name = "right.png"
        elif "背" in lower_name:
            new_name = "back.png"
        elif "正" in lower_name or "正面" in lower_name or "合成" in lower_name:
            new_name = "front.png"
        else:
            # 預設：如果不確定，先檢查檔案大小，或直接設為正面
            if not os.path.exists(os.path.join(directory, "front.png")):
               new_name = "front.png"
               
        if new_name:
            final_path = os.path.join(directory, new_name)
            old_path = os.path.join(directory, file_name)
            
            # 防止檔名衝突
            counter = 1
            while os.path.exists(final_path) and old_path != final_path:
                final_path = os.path.join(directory, f"{new_name.replace('.png', '')}_{counter}.png")
                counter += 1
                
            if old_path != final_path:
                os.rename(old_path, final_path)
                print(f"      Renamed file: {file_name} -> {os.path.basename(final_path)}")

print("Starting to rename assets to English format...")

if not os.path.exists(base_dir):
    print(f"Error: Directory {base_dir} not found.")
else:
    for folder_name in os.listdir(base_dir):
        folder_path = os.path.join(base_dir, folder_name)
        
        if os.path.isdir(folder_path):
            if folder_name in folder_mapping:
                new_folder_name = folder_mapping[folder_name]
                new_folder_path = os.path.join(base_dir, new_folder_name)
                
                # 重新命名資料夾
                os.rename(folder_path, new_folder_path)
                print(f"[*] Renamed folder: {folder_name} -> {new_folder_name}")
                
                # 重新命名資料夾內的圖片
                for file_name in os.listdir(new_folder_path):
                    clean_file_name(file_name, new_folder_path)
            else:
                 print(f"[-] Skipping unknown folder: {folder_name}")
                 
print("\nDone!")
