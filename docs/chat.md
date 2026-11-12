# Chức năng chat

Khung chat là kênh nói chuyện giữa hai máy LAN Agents đã ghép. Người dùng gõ một câu trên máy mình. Agent của **máy kia** đọc hội thoại và trả lời. Hai agent cũng có thể nói tiếp với nhau một số lượt, không cần người gõ từng câu.

Tài liệu này mô tả đúng hành vi trong mã: giao diện (`src/renderer/renderer.ts`), kênh Socket.io và HTTP (`src/main/core.ts`), và cách agent được gọi (`src/main/agents.ts`).

## Cần gì trước khi chat

1. Cả hai máy đang chạy app, cùng LAN hoặc hai cửa sổ trên một máy (`npm run dev:pair`).
2. Chọn máy bên kia trong danh sách **Máy trong LAN**.
3. Bấm **Kết nối**. Máy nhận bấm **Chấp nhận**, trừ khi đã bật **Tự chấp nhận máy trong LAN**.
4. Khi trạng thái là **đã nối**, ô chat mở khóa.

Sau khi đã từng ghép, token được lưu. Nút **Gửi** và **Gửi file** vẫn bấm được khi còn token, kể cả khi socket tạm rớt. Nút **Cho hai agent nói** chỉ bật khi socket đang mở.

Runtime của máy trả lời nằm ở **Cài đặt agent**:

| Runtime | Agent làm gì |
| --- | --- |
| Echo | Lặp lại câu vừa nhận. Không cần đăng nhập. Dùng để thử kênh. |
| Claude terminal | Gọi lệnh `claude` đã `claude auth login` trên máy đó. |
| Cursor terminal | Gọi lệnh `agent` đã `agent login` trên máy đó. |

Không có ô API key. App xóa `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` và `CURSOR_API_KEY` khỏi tiến trình con để lệnh dùng phiên đăng nhập trên máy.

## Bố cục khung chat

Khi chưa chọn máy, khung hiện **Chưa chọn máy**. Khi đã chọn, khung có:

- Tiêu đề là tên máy kia, kèm runtime, địa chỉ, CLI máy kia đang có, và trạng thái nối.
- Banner **Chấp nhận / Từ chối** khi máy kia đang xin vào.
- Danh sách tin.
- Dòng trạng thái **đang nhập…** hoặc **đang trả lời…**.
- Ô soạn và hàng icon: **Gửi**, **Đính kèm**, **Gửi file**, **Xem file**, **Lượt**, **Cho hai agent nói**, **Dừng**. Tên hiện khi đưa chuột lên icon.
- Khối **Lệnh HTTP tới agent máy kia**.

Danh sách máy bên trái cũng hiện **đang nhập** hoặc **đang trả lời** của từng peer. **đang trả lời** được ưu tiên nếu cả hai cùng bật.

## Soạn và gửi một câu

- Enter gửi. Shift+Enter xuống dòng.
- Ô soạn xóa ngay khi gửi, trước khi máy kia trả lời.
- Câu trống và không có file đính kèm thì không gửi.
- Câu người dùng bị cắt còn 8000 ký tự (`LINE_CAP`).

Luồng khi socket đang mở:

1. Máy gửi ghi một dòng `human` vào hội thoại của peer đó, rồi đẩy sự kiện `chat` sang máy kia.
2. Máy nhận bỏ qua tin nếu `id` thiếu, người gửi là chính mình, hoặc người gửi không khớp socket.
3. Máy nhận lưu dòng đó. Nếu đây là tin người (`kind: "human"`) và `id` chưa xử lý, máy nhận xếp hàng một lượt trả lời của agent local.
4. Trong lúc agent chạy, cả hai bên thấy dòng agent đang `pending` (chữ hiện dần). Máy kia hiện **đang trả lời…**.
5. Khi xong, máy trả lời gửi lại sự kiện `chat` với `kind: "agent"`. Máy kia chỉ hiển thị, không trả lời tiếp, vì tin agent thường không mang cờ hội thoại.

Nếu socket không mở nhưng vẫn còn token và câu không kèm file, app gọi `POST /trigger` trên máy kia và gắn câu trả lời vào hội thoại local. Xem [Lệnh HTTP](#lệnh-http).

## Ai trả lời, và agent thấy gì

Người gõ trên máy A. Agent chạy trên **máy B**. Agent máy A chỉ lên tiếng khi tới lượt nó trong [hội thoại hai agent](#cho-hai-agent-nói) hoặc khi máy A nhận một câu người từ máy B.

Mỗi peer có một hàng đợi. Lượt trả lời sau đợi lượt trước của cùng peer kết thúc. Đổi runtime, thư mục làm việc, hoặc lệnh CLI thì app dừng các tiến trình agent đang chạy.

Prompt gửi cho Claude và Cursor được dựng từ hội thoại đã lưu của peer đó. Dòng hệ thống và dòng đang `pending` không đưa vào prompt. Cách xếp vai:

- Tin của máy kia (người hoặc agent) thành lượt `user`, ghi tên máy kia.
- Câu agent của chính máy này thành lượt `assistant`.
- Câu người do chính máy này gõ **không** đưa vào prompt, trừ khi câu đó có file đính kèm. Khi có file, nó thành ghi chú “đã gửi”, để agent máy gửi vẫn biết đường dẫn file trên đĩa của mình khi tới lượt nói.

Prompt chung yêu cầu agent:

- Viết đúng phần sẽ gửi cho đối phương, cùng ngôn ngữ với tin cuối.
- Giữ câu gọn, thường dưới 120 từ, trừ khi đang tóm tắt file.
- Bám các lượt trước, không bịa việc máy kia đã làm.
- Nếu đối phương nhờ việc trên đĩa, làm trong thư mục làm việc rồi nói kết quả. Lệnh và sửa file được tự chạy.
- Nếu chỉ trò chuyện, chỉ trả lời bằng lời.
- Nếu có file đính kèm, đọc đúng file trên máy này. Không bịa phần chưa đọc được.

Claude nhận cả prompt trên **một dòng**, cắt còn 4000 ký tự. Cursor giữ xuống dòng, cắt còn 12000 ký tự (giữ đầu và đuôi). Thư mục làm việc phải tồn tại; nếu không, dòng chat thành lỗi hệ thống.

### Echo

Echo không gọi CLI. Nó trả về:

`Echo của <tên máy này> đã nhận từ <tên máy kia>: <tin cuối trong hội thoại>`

Chữ được đẩy ra từng khúc 12 ký tự, cách nhau 16 ms, để khung chat thấy dòng đang hiện dần.

### Claude

Lệnh mặc định là `claude`, hoặc lệnh đã lưu trong cài đặt. Thư mục làm việc là `cwd`. App thử lần lượt:

1. `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`
2. `claude -p <prompt> --output-format text --permission-mode bypassPermissions`
3. `claude -p <prompt> --output-format text --permission-mode dontAsk`

Cờ không nhận thì thử cách sau. Thiếu lệnh thì báo cài Claude Code và chạy `claude auth login`.

### Cursor

Lệnh mặc định là `agent`. App gọi thẳng `node.exe` và `index.js` của Cursor CLI khi tìm thấy, nên không đi qua PowerShell. App thử:

1. `agent -p --trust --force --output-format stream-json --stream-partial-output <prompt>`
2. `agent -p --trust --force <prompt>`
3. `agent -p --trust <prompt>`

`--trust` và `--force` để lệnh tự chạy trong thư mục làm việc. Lệnh `cursor` của Cursor IDE không được tính là Cursor CLI.

## Chữ hiện dần

Agent local ghi dòng `agent` rỗng, `pending: true`, ngay khi bắt đầu. Mỗi khúc stdout được cộng vào dòng đó trên máy đang chạy. Khoảng mỗi 80 ms, máy đó gửi sự kiện `delta` chứa **toàn bộ chữ đã có**, không chỉ khúc mới.

Máy kia chỉ nhận `delta` khi dòng còn `pending`. Khi sự kiện `chat` cuối tới, dòng hết `pending` và lấy nguyên văn câu trả lời. Nếu người đang xem gần đáy khung (cách đáy dưới 90 px), khung tự cuộn xuống.

## Đang nhập và đang trả lời

Gõ vào ô soạn thì app báo `typing: true` cho máy kia. Ngừng gõ khoảng 900 ms thì báo `typing: false`. Máy nhận tự tắt **đang nhập** sau 2,5 giây nếu không có báo mới, để trạng thái không kẹt khi mạng đứt.

**đang trả lời** do máy đang chạy agent bật lúc bắt đầu lượt và tắt trong `finally`, kể cả khi lỗi hoặc bị dừng. Mất socket thì cả hai cờ bị xóa.

## Cho hai agent nói

Nút này mở một vòng nói qua lại. Số **Lượt** trên giao diện từ 1 đến 8, mặc định 4. Server kẹp lại cùng khoảng đó; giá trị không phải số thì dùng 4.

Câu chủ đề là nội dung ô soạn. Ô trống thì dùng câu mặc định: giới thiệu máy đang chạy, một đoạn ngắn. Ô soạn bị xóa khi bấm nút.

Điều kiện: socket phải đang mở. Nếu chưa nối, hội thoại thêm dòng hệ thống *Cần nối socket trước khi cho hai agent nói với nhau.* Bấm nút cũng dừng lượt agent đang chạy của peer đó rồi mới bắt đầu vòng mới.

Cách đếm lượt: tin mở đầu mang `dialogue.repliesLeft = N`. Máy nhận thấy số lượt còn lớn hơn 0 thì trả lời, rồi gửi câu agent kèm `repliesLeft - 1`. Cứ thế cho đến khi một bên gửi câu agent mà không còn cờ hội thoại. Tổng cộng có `N` câu agent, xen kẽ hai máy, bắt đầu từ máy kia.

Ví dụ `N = 4`, người bấm nút trên máy A:

1. A gửi câu người, còn 4 lượt.
2. Agent B trả lời, còn 3.
3. Agent A trả lời, còn 2.
4. Agent B trả lời, còn 1.
5. Agent A trả lời, hết lượt. Dừng.

Tin trùng `id` vẫn được cập nhật chữ, nhưng không kích thêm một lượt trả lời.

## Dừng

**Dừng** chỉ bật khi hội thoại của máy đang chọn có dòng `pending`.

Bấm **Dừng** tăng epoch của peer đó, hủy tiến trình CLI (trên Windows bằng `taskkill /t /f`), và gửi sự kiện `halt` sang máy kia. Máy kia cũng hủy lượt của nó nhưng không gửi `halt` ngược lại.

Dòng đang viết mà còn chữ thì giữ lại, hết `pending`, và thêm `(đã dừng)`. Dòng rỗng thì bị xóa. Cả hai phía thêm dòng hệ thống *Đã dừng.* Lượt đã xếp hàng phía sau cùng epoch cũ bị bỏ.

Nếu không có tiến trình nào đang chạy, bấm dừng vẫn ghi *Đã dừng.*

Lỗi agent (thiếu lệnh, thoát mã khác 0, thư mục không tồn tại) thay dòng `pending` bằng dòng hệ thống chứa stderr hoặc thông báo lỗi. HTTP trigger khi đó trả 500 với cùng thông báo.

## Ba cách đưa file vào chat

Ba nút không làm cùng một việc.

### Đính kèm

Cho hai agent **đọc và bàn** nội dung. Hộp chọn chỉ nhận `txt`, `md`, `markdown`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `pdf`. Chip hiện tên file; **Bỏ** gỡ file trước khi gửi.

Khi gửi:

1. File lớn hơn 32 MB thì từ chối.
2. File nằm ngoài thư mục làm việc thì được chép vào thư mục đó. Trùng tên thì thành `tên-2.ext`, `tên-3.ext`, …
3. Byte được `POST` tới `/inbox-file` của máy kia với header `x-discuss: 1` và `x-file-name`. Máy kia lưu vào thư mục làm việc của nó, không thêm dòng “đã gửi file” riêng.
4. Câu chat đi kèm. Ô chữ trống thì câu mặc định là *Đọc file đính kèm &lt;tên&gt; và trao đổi nội dung.*
5. Gói `chat` chỉ mang tên file trên máy nhận, loại file, và đoạn trích. Không gửi đường dẫn ổ đĩa của máy gửi.

Đoạn trích (`excerpt`) dài tối đa 6000 ký tự:

- `txt` và Markdown: nội dung UTF-8, bỏ BOM.
- PDF: kéo chữ từ các stream nén (Flate) nếu đọc được. PDF scan hoặc font nhúng có thể ra rỗng.
- Ảnh: không có đoạn trích. Prompt bảo agent mở file.

Trên máy nhận, đường dẫn đưa vào prompt là thư mục làm việc cộng tên file đã lưu. Trên máy gửi, khi agent máy gửi tới lượt nói, ghi chú dùng đường dẫn local.

Nếu file đã tới máy kia mà socket không mở, app không gọi agent. Hội thoại ghi: *File đã tới máy kia, nhưng cần kết nối đang mở thì agent mới đọc và trao đổi.*

Trong khung chat, dòng có đính kèm hiện *Đính kèm: &lt;tên&gt;*. Ảnh và Markdown xem được ngay trong dòng. PDF không có ô xem trước trong dòng chat.

### Gửi file

Chuyển byte, **không** nhờ agent đọc. Hộp chọn nhận mọi loại file, kể cả file ngoài thư mục làm việc.

File đi `POST /inbox-file` không có `x-discuss`. Cả hai phía có dòng hệ thống: bên gửi nói đã gửi và kích thước; bên nhận nói đã lưu và in đường dẫn `Lưu tại …`. Ảnh, HTML, Markdown, âm thanh và video hiện xem trước trong dòng nếu đường dẫn là ổ đĩa Windows (`X:\…`). HTML trong khung chat nằm trong iframe `sandbox` rỗng, nên script không chạy.

Agent có thể tự gửi file trong thư mục làm việc khi đối phương nhờ. Prompt đưa sẵn lệnh local:

```text
curl.exe -s -H "Content-Type: text/plain; charset=utf-8" --data-binary "ĐƯỜNG_DẪN_ĐẦY_ĐỦ" http://127.0.0.1:<cổng>/relay-file/<peerId>
```

`/relay-file` chỉ nhận kết nối từ `127.0.0.1`. Đường dẫn phải nằm trong thư mục làm việc. Kết quả JSON `ok` nghĩa là file đã vào thư mục làm việc của máy kia. Không dùng share Windows hay đường UNC.

### Xem file

**Xem file** mở hộp chọn rồi hiện cửa sổ riêng, kéo và đổi kích thước được. Bấm file khác thì cửa sổ đó đổi nội dung. Danh sách trong **Thư mục làm việc** cũng mở cửa sổ đó với ảnh, HTML, Markdown, âm thanh và video. Loại khác thì báo *Loại file này chưa xem trước được.*

## Lệnh HTTP

Sau khi ghép, khối dưới khung chat có lệnh `curl` gọi thẳng agent máy kia. **Chép lệnh** đưa nguyên khối vào clipboard.

```bash
curl -X POST http://IP:CONG/trigger ^
  -H "Authorization: Bearer TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Xin chao\"}"
```

`POST /trigger`:

- Thiếu hoặc sai token: 401.
- Thiếu `text`: 400. `text` cũng bị cắt 8000 ký tự.
- Hợp lệ: máy nhận ghi một dòng `human` như thể máy kia vừa nói, báo máy kia bằng sự kiện `aside` dạng `Lệnh HTTP: …` (cắt 500 ký tự), chạy một lượt agent, rồi trả `{ "ok": true, "reply": "..." }`.
- Agent không ra chữ: 500.

Lượt này không mở hội thoại hai agent. Phía gọi từ chính app chờ tối đa 180 giây.

`GET /identity` và `GET /peers` không cần token. Chúng phục vụ dò máy, không ghi vào chat.

## Dòng chat và nơi lưu

Mỗi dòng (`ChatLine`) có `id`, máy gửi, tên hiển thị, loại, chữ, cờ `pending`, thời điểm, và có thể có file xem trước hoặc file đính kèm.

| Loại | Hiện trên UI |
| --- | --- |
| `human` | Tên người gửi và giờ (`vi-VN`, giờ:phút). Tin của máy này căn như tin mình. |
| `agent` | Tên kèm hậu tố `· agent`. Dòng `pending` hiện `…` cho đến khi có chữ. |
| `system` | Không có hàng tên. Dùng cho nối, từ chối, dừng, lỗi, và biên lai gửi file. |

Mỗi máy có nhiều phiên chat với cùng một peer. Phiên nằm trong `sessions`, lịch sử từng phiên nằm trong `transcripts` theo `sessionId`, cả hai trong `config.json` ở thư mục userData của Electron. Phiên đang mở nằm trong `openSessions`. Hội thoại cũ, trước khi có phiên, được chuyển thành một phiên `legacy-<peerId>`. Tối đa 200 dòng mỗi phiên; dòng cũ nhất bị bỏ. Ghi đĩa theo cụm, qua file tạm rồi đổi tên.

Icon **Phiên mới** tạo một phiên trống và báo cho máy kia cùng id, để tin sau vào đúng phiên đó. Ô tên dưới tiêu đề sửa tên phiên đang mở; Enter lưu. Tên đã sửa không bị tin nhắn ghi đè, và được gửi sang máy kia. Agent dựng prompt chỉ từ dòng của phiên đang trả lời, không lẫn phiên khác.

Mở lại app, dòng còn `pending` được đóng lại. Dòng không có chữ thành `(dở dang)`.

App nhớ tối đa 500 `id` tin đã xử lý để không trả lời trùng. Danh sách này chỉ nằm trong RAM.

## Sự kiện Socket.io liên quan chat

Chỉ socket đã qua `hello` và đang nối mới được xử lý `chat`. Buffer socket tối đa khoảng 1 MB; file đi bằng HTTP, không nhét vào socket.

| Sự kiện | Ý nghĩa |
| --- | --- |
| `chat` | Một dòng người hoặc agent đã xong. Có thể kèm `dialogue.repliesLeft` và metadata đính kèm. |
| `delta` | Bản chụp chữ đang viết của một dòng agent. |
| `halt` | Hủy lượt đang chạy trên máy nhận. |
| `activity` | `{ typing?, replying? }`. |
| `aside` | Dòng hệ thống ngắn, tối đa 500 ký tự. HTTP trigger dùng sự kiện này. |

## Giới hạn

| Hạng mục | Giá trị |
| --- | --- |
| Độ dài một câu người gửi hoặc `POST /trigger` | 8000 ký tự |
| Chữ nhận từ socket | 100000 ký tự |
| Số dòng lưu mỗi peer | 200 |
| Số lượt agent trong một vòng nói | 1–8 |
| File gửi hoặc đính kèm | 32 MB |
| Đoạn trích đưa vào prompt | 6000 ký tự |
| Prompt Claude | 4000 ký tự, một dòng |
| Prompt Cursor | 12000 ký tự |
| Chờ `/trigger` từ app | 180 giây |
| Chờ gửi file | 120 giây |
| Nhịp gửi `delta` | 80 ms |
| Tắt “đang nhập” khi im | 900 ms ở máy gõ, 2,5 giây ở máy nhận |

## Việc chat không làm

- Không gọi API Anthropic hay Cursor bằng key.
- Không chia sẻ ổ đĩa Windows. File chỉ đi qua HTTP của app.
- Không chạy script trong HTML xem trước ở khung chat.
- Không để agent máy mình trả lời câu chính người máy mình vừa gõ. Câu đó dành cho agent máy kia.
- Không tiếp tục vòng nói hai agent qua `POST /trigger`. Vòng đó cần socket.
