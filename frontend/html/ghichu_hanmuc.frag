<!-- UC-33 — Dọn dung lượng (phía người học, mẫu `han-muc-nguoi-hoc.html` màn p-clean). Logic: js/ghichu_hanmuc.js,
     style: css/ghichu_hanmuc.css (tiền tố hm-). Chiếm trọn cột giữa như các công cụ Studio (isFullPaneTool ở ghichu.js).
     Thanh Dung lượng, dải nhắc và số lượt AI trên thẻ Studio do cùng module chèn vào cột Notebook / cột Studio. -->
<section class="hm-pane" id="hm-pane" hidden>
  <div class="hm-wrap">
    <div class="hm-ph">
      <div class="hm-ph-t"><h1>Dọn dung lượng</h1><p id="hm-sub"></p></div>
      <button type="button" class="hm-btn" id="hm-back">Quay lại Notebook</button>
    </div>
    <div class="hm-card hm-usage">
      <div class="hm-ubar" id="hm-ubar"></div>
      <div class="hm-legend" id="hm-legend"></div>
      <div id="hm-need"></div>
    </div>
    <div class="hm-filters" id="hm-filters"></div>
    <div class="hm-card hm-table-card">
      <div class="hm-table" id="hm-table"></div>
      <div class="hm-selbar" id="hm-selbar"></div>
    </div>
  </div>
</section>
