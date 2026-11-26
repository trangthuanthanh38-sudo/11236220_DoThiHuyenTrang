-- =============================================================================
-- knowledge_content_schema_v2.sql — Nét vẽ / hình khối / nền trang của Chương (thẻ Draw, UC-16 mở rộng)
-- =============================================================================
-- Thẻ Draw vẽ TRỰC TIẾP trên trang soạn thảo (bút, bút dạ, hình khối có chữ, nền dòng kẻ / ô lưới) — lớp vẽ nằm
-- CHỒNG lên nội dung, KHÔNG ghi vào HTML của CKEditor (content_json) nên:
--   * không đổi content_text / không kích hoạt re-embed RAG, không tăng content_version (khoá lạc quan của chia sẻ);
--   * nội dung chữ và nét vẽ sửa độc lập (sửa chữ không làm mất nét vẽ và ngược lại).
-- drawing_json (JSON, NULL = chưa vẽ gì):
--   {"v":1,
--    "bg":{"kind":"none|rule|grid","size":"narrow|college|standard|wide|small|medium|large|xlarge","margin":true|false},
--    "items":[
--      {"id":"…","t":"ink","pen":"pen|pencil|marker|fountain|galaxy","color":"#rrggbb","w":3,"op":1,
--       "pts":[[x,y],…]},                                 -- toạ độ px CSS tính từ góc trên-trái trang soạn thảo
--      {"id":"…","t":"shape","shape":"rect|ellipse|line|arrow|…","x":,"y":,"w":,"h":,
--       "stroke":"#…","fill":"#…|none","sw":2,"text":"…"} -- đường thẳng: x,y → x+w,y+h (w/h có thể âm)
--    ]}
-- File PDF KHÔNG dùng cột này — nét vẽ / hình khối trên PDF lưu ở pdf_annotations (type 'draw' / 'shape', toạ độ
-- PDF user space như cũ).
-- Docker nạp file này SAU knowledge_content_schema.sql (thứ tự chữ cái: ".sql" < "_v2.sql").
SET NAMES utf8mb4;

ALTER TABLE chapters
    ADD COLUMN drawing_json JSON NULL;   -- không dùng AFTER: content_updated_at do sharing_schema.sql (nạp SAU file này) thêm
