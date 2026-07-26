# Đường đen Vietphrase Realtime Translator

Công cụ dịch nội dung tiếng Trung trên trang web sang tiếng Việt bằng từ điển Vietphrase.

Có hai phiên bản:

- **Chrome Extension 2.1.9**: đầy đủ tính năng, phù hợp khi dùng từ điển lớn.
- **Userscript 2.2.8**: cài qua Tampermonkey hoặc Violentmonkey.

> Không nên bật Extension và Userscript cùng lúc vì trang web có thể bị dịch hai lần.

## Cài Chrome Extension

1. Giải nén file:

   ```text
   vietphrase-ext-v2.1.9.zip
   ```

   Hoặc sử dụng trực tiếp thư mục `dist/`.

2. Mở Chrome và truy cập:

   ```text
   chrome://extensions
   ```

3. Bật **Chế độ dành cho nhà phát triển** (**Developer mode**).
4. Chọn **Tải tiện ích đã giải nén** (**Load unpacked**).
5. Chọn thư mục vừa giải nén hoặc thư mục `dist/`.

Sau khi cài xong, biểu tượng Vietphrase sẽ xuất hiện trên thanh công cụ Chrome.

## Sử dụng Chrome Extension

### Dịch trang

1. Mở trang web có nội dung tiếng Trung.
2. Extension tự động dịch nội dung sang tiếng Việt.
3. Nhấn biểu tượng Extension để bật, tắt hoặc thay đổi tùy chọn dịch.

Nếu trang chưa được dịch, hãy tải lại trang hoặc bật lại chức năng dịch trong popup.

### Sao chép chữ Hán gốc

1. Chọn phần tiếng Việt đã được dịch.
2. Nhấn chuột phải.
3. Chọn **Sao chép chữ Hán gốc**.

### Thêm hoặc sửa một mục từ

1. Chọn đoạn văn bản cần chỉnh sửa.
2. Nhấn chuột phải.
3. Chọn:
   - **Thêm / Sửa Vietphrase**
   - **Thêm / Sửa Name (tên riêng)**
4. Nhập nghĩa tiếng Việt và lưu lại.

### Quản lý từ điển

Mở popup của Extension và chọn trình sửa từ điển. Tại đây có thể:

- Tìm kiếm mục từ.
- Thêm mục mới.
- Sửa nghĩa tiếng Việt.
- Xóa hoặc khôi phục mục từ.
- Export các mục đã chỉnh sửa.

### Thay toàn bộ từ điển

Trong popup, chọn file TXT tương ứng với:

- `PA`: phiên âm từng chữ Hán.
- `VP`: từ điển Vietphrase.
- `Names`: tên người, địa danh và tên riêng.

File từ điển phải có định dạng:

```text
chữ Hán=nghĩa tiếng Việt
```

Ví dụ:

```text
秦始皇=Tần Thủy Hoàng
```

Sau khi upload, Extension sẽ tải lại từ điển và dịch lại các tab đang mở.

## Cài Userscript

Userscript yêu cầu Tampermonkey hoặc Violentmonkey.

1. Cài Tampermonkey hoặc Violentmonkey cho trình duyệt.
2. Mở dashboard của userscript manager.
3. Chọn tạo userscript mới hoặc import userscript.
4. Mở file:

   ```text
   dist-userscript/vietphrase.user.js
   ```

5. Dán toàn bộ nội dung file vào trình chỉnh sửa.
6. Lưu userscript.
7. Mở hoặc tải lại trang web có nội dung tiếng Trung.

## Sử dụng Userscript

Mở menu của Tampermonkey hoặc Violentmonkey để dùng bốn lệnh:

- **Dịch trang**: dịch nội dung hiện tại.
- **Làm mới bản dịch**: khôi phục chữ Hán và dịch lại.
- **Sao chép chữ Hán gốc**: sao chép chữ Hán tương ứng với phần tiếng Việt đang chọn.
- **Từ điển cá nhân**: upload từ điển `PA`, `VP` hoặc `Names`.

### Upload từ điển cá nhân

1. Mở menu userscript.
2. Chọn **Từ điển cá nhân**.
3. Chọn `PA`, `VP` hoặc `Names`.
4. Upload file TXT có định dạng `Hán=Việt`.

File cá nhân sẽ thay thế toàn bộ bộ từ điển tương ứng. Userscript chỉ tải lại từ điển mặc định khi bộ đó chưa có dữ liệu.

## Khắc phục sự cố

### Trang không được dịch

- Kiểm tra Extension hoặc Userscript đang được bật.
- Tải lại trang.
- Thử lệnh **Dịch trang**.
- Kiểm tra trang có thực sự chứa chữ Hán hay không.

### Trang bị dịch hai lần

Tắt một trong hai: Chrome Extension hoặc Userscript.

### Lần dịch đầu tiên bị chậm

Bộ từ điển Vietphrase có thể rất lớn nên lần tải đầu tiên cần thêm thời gian. Các lần dịch tiếp theo thường nhanh hơn sau khi từ điển đã được tải.

### Từ hoặc tên riêng dịch chưa đúng

- Với Extension: dùng menu chuột phải để sửa mục từ.
- Với Userscript: chỉnh file từ điển cá nhân rồi upload lại.

## Phiên bản

- Chrome Extension: `2.1.9`
- Userscript: `2.2.8`

## License

GPL-3.0-only.
