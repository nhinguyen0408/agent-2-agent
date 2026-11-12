# LAN Agents

Hai cửa sổ (hoặc hai máy Windows trong cùng LAN) tự tìm nhau. Máy nhận chạy agent local và trả lời qua Socket.io. Mỗi máy cũng mở một HTTP server để nhận lệnh `POST /trigger`.

Runtime mặc định là **Echo**: trả lại đúng câu nhận được. Claude và Cursor dùng terminal đã đăng nhập trên từng máy, không dùng API key.

## Chạy thử trên một máy

```bash
npm install
npm run dev:pair
```

Hai cửa sổ Agent A và Agent B hiện ra. Chọn máy bên kia, bấm **Kết nối**, rồi gửi một câu. Echo của máy kia trả lời trong khung chat.

`npm run dev` chỉ mở Agent A. `npm run dev:b` chỉ mở Agent B.

## Hai máy thật

Cài cùng một bản trên cả hai máy, cùng Wi-Fi hoặc cùng switch (không dùng Wi-Fi khách, VLAN tách, hay VPN):

```bash
npm install
npm start
```

Lần đầu Windows Firewall hỏi thì chọn mạng riêng tư.

Đóng gói bộ cài:

```bash
npm run dist
```

File cài nằm trong `release/`. Cài file đó trên mỗi máy.

Nếu danh sách LAN trống, nhập IP và cổng (mặc định 3940) vào ô dưới danh sách máy.

## Claude và Cursor

Trong **Cài đặt agent**, chọn terminal rồi bấm **Lưu cài đặt**. Không có ô API key.

Trên máy sẽ chạy agent, đăng nhập một lần trong terminal của máy đó:

- Claude Code: cài `claude`, rồi chạy `claude auth login`. App gọi `claude -p`.
- Cursor CLI: cài `agent`, rồi chạy `agent login`. App gọi `agent -p`.
- App tự nhận `claude` và `agent` trên máy (kể cả thư mục cài mặc định), rồi hiện Đã cài hoặc Chưa có. Lệnh `cursor` của Cursor IDE không tính là Cursor CLI.

Phiên đăng nhập nằm trên máy đó. App xóa `ANTHROPIC_API_KEY` và `CURSOR_API_KEY` khỏi tiến trình con để lệnh dùng đúng phiên này. Thư mục làm việc là thư mục terminal được mở khi có việc trên đĩa.

## HTTP trigger

Sau khi hai máy đã ghép, khung chat có lệnh `curl` gọi thẳng agent máy kia:

```bash
curl -X POST http://IP:CONG/trigger ^
  -H "Authorization: Bearer TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Xin chao\"}"
```

`GET /identity` và `GET /peers` không cần token.

## Chấp nhận kết nối

Mặc định máy kia phải bấm **Chấp nhận**. Ô **Tự chấp nhận máy trong LAN** bỏ qua bước đó. Chỉ bật trên mạng nhà: máy lạ cùng Wi-Fi có thể kích agent.

## Kiểm tra tự động

```bash
npm run smoke
```

Script mở hai tiến trình Echo, đợi chúng thấy nhau, gửi một câu qua giao diện và chờ câu trả lời Echo.
