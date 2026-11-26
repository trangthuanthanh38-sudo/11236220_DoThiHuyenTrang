    <!-- Fragment MODULE 1 (ghichu_soanthao.js): khung xem/chú thích PDF — thay chỗ cho
         .editor-shell khi đang mở 1 File PDF, ẩn/hiện qua switchEditorView() trong
         ghichu_soanthao.js. Cuộn dọc liên tục: mỗi trang là 1 khối .pdf-page-block (canvas +
         overlay + textbox-layer + interact-layer riêng), được renderAllPdfPages() trong
         ghichu_soanthao.js sinh động vào #pdf-pages-scroll — không có canvas/layer tĩnh trong
         HTML. Công cụ chú thích (textbox/tô màu/vẽ/xoá) nằm ở tab Draw của ribbon khi host này
         đang hiện. Nạp vào trang qua fetch() + thay thế #mount-soanthao-pdfhost, xem đầu
         ghichu.js — vị trí (ngay sau .editor-shell, trong .editor-scroll) được giữ nguyên. -->
    <div id="pdf-host" hidden>
      <div class="pdf-pages-scroll" id="pdf-pages-scroll"></div>
    </div>
