# Logmoney

Ứng dụng PWA mobile-first để ghi chi tiêu hằng ngày, theo dõi ngân sách tháng và xem danh mục đang chi nhiều nhất. Firebase Authentication xử lý đăng nhập Google; Cloudflare Worker xác minh Firebase ID token rồi dùng service account riêng trên server để truy cập Firestore. Không đặt service-account key hoặc quyền truy cập Firestore trong trình duyệt.

## Chạy giao diện dùng thử

```sh
npm install
npm run dev
```

Không cần cấu hình Firebase để xem thử. Chế độ dùng thử lưu sổ chi tiêu và ngân sách trong localStorage của trình duyệt; dữ liệu mẫu chỉ nằm trên thiết bị đó.

## Bật Google Auth và Firestore

1. Tạo ứng dụng web trong Firebase Console, bật **Authentication → Google** và tạo Firestore database.
2. Thêm URL ứng dụng trong Firebase Authentication → Settings → Authorized domains.
3. Sao chép `.env.example` thành `.env.local` và điền Firebase Web API key, Auth domain, Project ID, App ID. Các giá trị cấu hình web không phải service-account secret.
4. Đặt file service account tải từ Google Cloud tại `worker/adminsdk.json`. File này đã được loại trừ khỏi Git. Cấp service account quyền Firestore phù hợp (ví dụ **Cloud Datastore User**).

```sh
# Terminal 1
npm run dev:worker

# Terminal 2
npm run dev
```

`dev:worker` đọc `worker/adminsdk.json` và ghi các giá trị vào `.dev.vars` theo định dạng Wrangler yêu cầu (không bọc JSON service account trong dấu ngoặc kép ngoài). File này được Git bỏ qua và đặt quyền chỉ chủ sở hữu đọc/ghi. Khi deploy lên Cloudflare, cần tự cấu hình `FIREBASE_PROJECT_ID` và `SERVICE_ACCOUNT_JSON` dưới dạng encrypted Worker secrets trong tài khoản Cloudflare của bạn trước khi chạy `npm run deploy:worker`. Giới hạn quyền service account ở mức cần thiết và luân phiên key định kỳ.

5. Deploy web ở cùng origin với Worker, hoặc cấu hình reverse proxy `/api/*` tới Worker. Khi frontend và Worker khác origin, đặt `ALLOWED_ORIGIN` trong `wrangler.toml` đúng origin web trước khi deploy. Cập nhật `vite.config.ts` proxy target cho Worker trong môi trường phát triển nếu không dùng Worker local tại cổng 8787.

Worker lưu dữ liệu riêng trong namespace `apps/logmoney`: giao dịch tại `apps/logmoney/users/{uid}/expenses`, ngân sách tại `apps/logmoney/users/{uid}`, MCP token metadata tại `apps/logmoney/users/{uid}/mcpTokens` và token index tại `apps/logmoney/mcpTokens`. UID được lấy từ thông tin xác thực đã xác minh, không nhận uid từ request. Worker tự sao chép dữ liệu cũ từ `users/{uid}` sang namespace mới khi người dùng hoặc token MCP được dùng; dữ liệu legacy vẫn được giữ nguyên để rollback/đối chiếu. Firestore Security Rules vẫn nên để client không được truy cập trực tiếp nếu chỉ Worker được phép đọc/ghi.

## Deploy GitHub Pages

Workflow `.github/workflows/pages.yml` build và deploy frontend khi push lên nhánh `main`. Vite base path tự đặt theo tên repository; frontend gọi API tại Cloudflare Worker qua `VITE_API_BASE_URL`.

1. Tạo private repository tên `logmoney` trong tài khoản GitHub của bạn, rồi push source lên nhánh `main`. Không commit `.env`, `.dev.vars` hoặc `worker/adminsdk.json`; các file này đã được Git ignore.
2. Trong **Settings → Pages**, chọn **GitHub Actions** làm source. Private repository cần gói GitHub hỗ trợ Pages cho private repositories.
3. Trong **Settings → Secrets and variables → Actions → Variables**, tạo `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` và `VITE_API_BASE_URL` (URL HTTPS của Worker, không có dấu `/` cuối).
4. Deploy Worker riêng bằng Wrangler sau khi tự cấu hình hai encrypted secrets `FIREBASE_PROJECT_ID` và `SERVICE_ACCOUNT_JSON` trong Cloudflare. Đặt Worker variable `ALLOWED_ORIGIN` thành origin GitHub Pages chính xác, ví dụ `https://<github-owner>.github.io` (không thêm `/logmoney`). Thêm `<github-owner>.github.io` vào Firebase Authentication → Authorized domains.
5. Push commit lên `main`; xem trạng thái tại tab **Actions**. URL project site thường là `https://<github-owner>.github.io/logmoney/`.

Có thể cài/cập nhật Actions Variables bằng GitHub CLI sau khi chạy `gh auth login`:

```sh
npm run github:variables -- https://github.com/<owner>/logmoney https://<worker-name>.<account-subdomain>.workers.dev
```

Script đọc bốn biến Firebase từ `.env`, nhận Worker URL ở đối số, và chỉ ghi tên biến (không in giá trị) khi hoàn tất. Kiểm tra trước bằng cách thêm `--dry-run` vào cuối lệnh.

GitHub Pages chỉ host frontend tĩnh; Worker mới xử lý đăng nhập/data API. Không nhập service-account key vào GitHub Pages variables hoặc bundle frontend. Nếu thiếu biến Firebase/API, site chỉ chạy chế độ demo localStorage trên thiết bị.

## Kết nối AI assistant qua MCP

MCP endpoint là `/mcp`, dùng **Streamable HTTP stateless**: mỗi POST là một JSON-RPC request độc lập; server không cấp `Mcp-Session-Id` và không giữ session. Với web app cùng origin, endpoint là `https://<domain>/mcp`; khi deploy khác origin, reverse proxy đường dẫn `/mcp` tới Worker cùng với `/api/*`.

1. Đăng nhập bằng Google, mở **Cá nhân → Kết nối AI assistant**, tạo một token có nhãn riêng cho assistant.
2. Sao chép token ngay lúc tạo — token đầy đủ chỉ hiển thị một lần. Cấu hình MCP client với URL `/mcp` và header `Authorization: Bearer <token>`. Không đặt token trong prompt, repo, hoặc client-side code. Có thể thu hồi token bất kỳ lúc nào trong app.
3. Assistant có thể dùng `list_expenses`, `get_spending_summary`, `get_budget`, `create_expense`, `delete_expense`, `set_monthly_budget`. Token gắn với đúng tài khoản đã tạo nó; token database chỉ lưu SHA-256 hash. Xóa giao dịch và sửa ngân sách là thao tác ghi; yêu cầu assistant xác nhận trước khi thực hiện.

### MCP sandbox local

Chạy `npm run dev:worker`. Lệnh này tạo token test ngẫu nhiên, in token ra terminal một lần và cấu hình MCP test token riêng cho lần chạy đó. Kết nối MCP client tới `http://localhost:8787/mcp` với token đó. Token chỉ truy cập `apps/logmoney/users/mcp-sandbox`, tách biệt với dữ liệu tài khoản thật và các app khác. Tool `reset_test_data` xóa và khôi phục các giao dịch mẫu trong sandbox để có thể lặp lại bài test; khởi động lại Worker sẽ tạo token test mới. Chạy `npm run dev` để mở web app.

MCP test token chỉ có trong local Wrangler secrets; không cấu hình secret này cho Worker production. Với hosted assistant, dùng endpoint HTTPS production và token cá nhân tạo từ trang **Cá nhân**.

## Cài trên điện thoại

Deploy web qua HTTPS, mở bằng trình duyệt di động rồi chọn **Add to Home Screen / Thêm vào màn hình chính**. Manifest bật chế độ standalone và bố cục ưu tiên màn hình nhỏ.

## Kiểm tra

```sh
npm run build
```
