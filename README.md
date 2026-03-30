# Vietphrase Realtime Translator Lite

Userscript dịch trực tiếp tiếng Trung sang tiếng Việt trên mọi trang web, sử dụng từ điển Vietphrase.

---

## Tính năng

- Dịch realtime toàn bộ nội dung Hán văn trên trang khi tải xong
- Hỗ trợ từ điển: Vietphrase, PhiênÂm (âm Hán-Việt), tên riêng (Names)
- Panel nổi (floating panel) với các nút: Dịch, Làm mới, Bật/Tắt
- Hỗ trợ MutationObserver để dịch nội dung ajax/lazy-load tự động
- Tooltip hiện bản gốc khi rê chuột lên đoạn đã dịch
- Tương thích desktop và mobile (touch)
- Menu Tampermonkey để thao tác nhanh

---

## Cài đặt

### Bước 1 — Cài Tampermonkey

| Trình duyệt | Link |
|---|---|
| Chrome / Edge / Brave | [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/) |
| Safari | [App Store](https://apps.apple.com/app/tampermonkey/id1482490089) |

### Bước 2 — Cài userscript

```
[https://greasyfork.org/en/scripts/571806-vietphrase-realtime-translator-lite](https://greasyfork.org/en/scripts/571806-vietphrase-realtime-translator-lite)
```

---

## Sử dụng

Sau khi cài, truy cập bất kỳ trang web có chữ Hán. Script sẽ tự động dịch.

### Panel nổi (góc phải màn hình)

| Nút | Chức năng |
|---|---|
| **Dịch** | Dịch toàn bộ trang ngay lập tức |
| **Làm mới** | Khôi phục bản gốc rồi dịch lại |
| **Bật/Tắt** | Bật hoặc tắt chức năng tự động dịch |
| **‹ / ›** | Thu gọn / mở rộng panel |

### Menu Tampermonkey

Click icon Tampermonkey → chọn lệnh:

- **▶ Dịch trang** — dịch thủ công
- **🔄 Làm mới bản dịch** — dịch lại từ đầu
- **⟳ Tải lại từ điển từ nguồn** — xóa cache và tải lại từ điển mới nhất
- **⏯ Bật/Tắt auto translate**

---

## Từ điển

Ba file từ điển trong repo này được script tải tự động lần đầu chạy:

| File | Mô tả |
|---|---|
| `Vietphrase.txt` | Từ điển chính Hán-Việt (từ ghép, thành ngữ) |
| `ChinesePhienAmWords.txt` | Phiên âm từng chữ Hán đơn |
| `Names.txt` | Tên người, địa danh |

Định dạng mỗi dòng: `từ_hán=nghĩa_việt`

---

## License

[GPL-3.0](LICENSE)
