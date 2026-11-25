# Quy trình làm việc nhóm với LAN Agents

Tài liệu này mô tả cách một nhóm dùng LAN Agents để đi từ tài liệu BA tới code đã merge. Đây là **quy trình đích**: nó cần 5 tính năng chưa có trong mã hiện tại. Mục [Tính năng cần có](#tính-năng-cần-có) ghi rõ phần nào đã có nền và phần nào phải làm mới. Hành vi chat hiện tại xem ở [chat.md](chat.md).

## Nguyên tắc

**Người quyết định, agent thực thi.** Người chỉ can thiệp ở ba điểm duyệt: phạm vi công việc, hợp đồng API và PR. Ngoài ba điểm đó, agent tự chạy.

Agent của ai chạy trên máy người đó, với code, môi trường và phiên đăng nhập CLI của người đó. Đây là điểm LAN Agents khác với một người dùng Claude Code riêng lẻ: các agent nằm trên nhiều máy và phối hợp với nhau.

## Tính năng cần có

| Tính năng | Dùng ở bước | Nền đã có trong mã |
| --- | --- | --- |
| Bảng task và agent điều phối | 2, 3, 5 | Nhóm tối đa 5 máy, vai PO/PM/BA/SA/BE/FE/Tester, xếp lượt bằng `TurnTicket`, gọi agent bằng @mention (`src/shared/group.ts`) |
| Điểm duyệt của người | 3, 4, 6 | Chưa có. Chỉ có nút **Dừng** và chặn quyền bằng regex (`src/shared/access.ts`) |
| Hợp đồng API dùng chung | 4, 5 | Chưa có. Chủ đề có file tham khảo, tối đa 8 file (`src/shared/brief.ts`) |
| Git và PR tự động | 5, 6 | Chưa có. Chế độ coding đã ghi lại từng bước sửa file và chạy lệnh (`src/shared/codingLive.ts`) |
| Bot Slack | 1, 2, 5, 7 | Chưa có. Có HTTP `POST /trigger` để gọi agent từ bên ngoài |

Chủ đề dự án, chế độ coding, dấu `KẾT QUẢ` / `CẦN THÊM: N` và file `ket-qua.md` đã có sẵn. Quy trình dưới đây dùng lại các phần này.

## Chuẩn bị

Làm một lần cho mỗi dự án.

Ví dụ một nhóm bốn người:

| Người | Máy | Agent và vai | Người duyệt gì |
| --- | --- | --- | --- |
| Tech lead | Máy 1 | Claude, vai PM (điều phối) và SA | Phạm vi, kiến trúc, hợp đồng API |
| Dev BE | Máy 2 | Claude, vai BE | PR backend |
| Dev FE | Máy 3 | Cursor, vai FE | PR frontend |
| QA | Máy 4 | Gemini, vai Tester và review chéo | Kết quả kiểm thử |

Việc cần làm:

- Repo có `CLAUDE.md` và quy ước code chung. Mọi agent trong nhóm đọc cùng một bản.
- Thư mục làm việc trên mỗi máy trỏ vào đúng repo. Bật **giới hạn trong thư mục làm việc** (`confineWorkDir`).
- Mỗi máy chỉ cấp quyền cần cho vai của mình. Ví dụ máy Tester không cần quyền xóa file.
- Có một kênh Slack cho tính năng, đã nối với bot.

## Bảy bước

Ví dụ xuyên suốt: tính năng **Quản lý đơn hàng**, đã có tài liệu BA.

### Bước 1. Khởi tạo

Tech lead gõ trên Slack:

```text
/lan new "Quản lý đơn hàng" --template feature --doc BA-don-hang.docx --team BE,FE,Tester
```

Bot tạo chủ đề theo mẫu **Tính năng mới**, mời các máy vào nhóm và gắn tài liệu BA vào chủ đề.

### Bước 2. Đọc tài liệu và hỏi lại

Agent PM đọc tài liệu BA và liệt kê chỗ còn mơ hồ. Ví dụ: *Đơn bị hủy sau khi đã thanh toán thì hoàn tiền tự động hay thủ công?*

Câu hỏi được gửi vào Slack. BA hoặc PO trả lời trong thread. Câu trả lời được ghi vào chủ đề để mọi agent cùng đọc.

Không bỏ bước này. Tài liệu BA mơ hồ là nguyên nhân phổ biến nhất khiến agent làm sai.

### Bước 3. Tách task — điểm duyệt 1

Agent PM tạo bảng task, kèm vai và phụ thuộc:

```text
#1 [SA]     Thiết kế schema và hợp đồng API đơn hàng
#2 [BE]     API tạo, sửa, hủy đơn             ← cần #1
#3 [BE]     Tích hợp thanh toán và hoàn tiền  ← cần #1
#4 [FE]     Màn danh sách và chi tiết đơn     ← cần #1, dùng mock
#5 [FE]     Luồng hủy đơn                     ← cần #1, dùng mock
#6 [Tester] Test theo tiêu chí chấp nhận      ← cần #2 đến #5
```

Tech lead kiểm tra phạm vi đã đúng chưa và task nào quá lớn. Sửa xong thì bấm **Duyệt**. Chưa duyệt thì không agent nào được bắt đầu code.

### Bước 4. Hợp đồng API — điểm duyệt 2

Agent SA viết `openapi.yaml` và schema cơ sở dữ liệu. Dev BE và dev FE cùng duyệt.

Sau khi duyệt, hợp đồng bị khóa. Muốn đổi thì phải tạo yêu cầu thay đổi, và cả hai bên duyệt lại.

### Bước 5. Làm song song

- Agent BE trên máy 2 làm trên nhánh `feat/don-hang-be`: task #2 rồi #3, mỗi task một commit. Agent chạy unit test trên máy thật.
- Agent FE trên máy 3 làm trên nhánh `feat/don-hang-fe`: dựng mock từ hợp đồng, làm #4 và #5 cùng lúc với BE.
- Nếu BE thấy cần đổi API, agent BE gửi yêu cầu đổi hợp đồng. Agent FE được báo, và người duyệt như ở bước 4.

Người không cần ngồi xem. Slack chỉ báo khi một task xong, khi agent bị chặn, hoặc khi cần người duyệt.

### Bước 6. PR và review — điểm duyệt 3

Mỗi task xong thì agent tự mở PR, rồi:

1. Một agent khác hãng review. Ví dụ Gemini review code Claude viết. Agent tác giả sửa theo comment.
2. CI chạy test. Test hỏng thì agent tác giả tự sửa, không chuyển cho người.
3. Người duyệt PR cuối cùng: dev BE duyệt PR backend, dev FE duyệt PR frontend. Comment trên diff, agent sửa theo.
4. Chỉ người được merge.

### Bước 7. Kiểm thử và chốt

Agent Tester viết test theo đúng từng tiêu chí chấp nhận trong tài liệu BA, rồi chạy kiểm thử tích hợp trên máy 4.

Khi mọi test đạt, agent PM viết báo cáo bắt đầu bằng `KẾT QUẢ`, gồm:

- việc đã làm và các PR liên quan;
- tiêu chí chấp nhận nào đã đạt;
- quyết định đã chốt, được lưu vào bộ nhớ dự án;
- việc còn tồn.

Báo cáo được gửi vào Slack và cập nhật ticket Jira.

## Thời gian của người

Ước lượng cho một tính năng cỡ vừa. Chưa có số liệu đo thực tế.

| Bước | Người làm | Thời gian |
| --- | --- | --- |
| 1. Khởi tạo | Tech lead | 5 phút |
| 2. Trả lời câu hỏi | BA hoặc PO | 15–30 phút |
| 3. Duyệt task | Tech lead | 10–15 phút |
| 4. Duyệt hợp đồng | Dev BE và dev FE | 20–30 phút |
| 6. Duyệt PR | Dev BE, dev FE | 15–30 phút mỗi PR |
| 7. Đọc báo cáo | Cả nhóm | 10 phút |

Thời gian của người dành cho quyết định và review, không phải để gõ code.

## Nên làm

- Tài liệu BA có tiêu chí chấp nhận đánh số, ví dụ *AC-1: Đơn chưa thanh toán được hủy không mất phí*. Agent Tester và agent review bám vào các mã này.
- Làm hợp đồng trước, code sau. Không có hợp đồng thì BE và FE không chạy song song được.
- Chia task nhỏ: mỗi task khoảng một PR, dưới 400 dòng thay đổi.
- Để model khác hãng review nhau.
- Đặt giới hạn lượt cho mỗi task. Agent bế tắc thì dừng và hỏi, không đốt token.
- Sau mỗi chủ đề, lưu các quyết định vào bộ nhớ dự án để lần sau agent không hỏi lại.

## Không nên

- Đưa tài liệu BA sơ sài rồi để agent tự đoán.
- Cho agent tự merge, hoặc bỏ điểm duyệt để chạy cho nhanh.
- Để một chủ đề ôm cả một module lớn. Chia theo tính năng.
- Ngồi xem từng lượt agent nói. Làm vậy thì mất lợi thế so với tự dùng Claude Code.
- Cho hai agent sửa cùng một nhánh hoặc cùng một file.

## Đo hiệu quả

Sau ba đến năm tính năng, so với cách làm cũ:

- Thời gian từ tài liệu BA tới merge.
- Số giờ người bỏ ra cho mỗi tính năng.
- Số bug QA hoặc production phát hiện sau merge.
- Số lần agent bị chặn hoặc phải hỏi lại. Con số này cao nghĩa là tài liệu BA hoặc hợp đồng chưa đủ rõ.
- Chi phí token cho mỗi tính năng.

Nếu các số này không tốt hơn cách làm cũ thì chưa nên mở rộng quy trình cho nhiều nhóm.
