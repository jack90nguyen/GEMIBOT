// Rules hệ thống hardcode trong code — không phụ thuộc RULES.md
// Nếu user xóa RULES.md, các rules này vẫn luôn được inject vào session

const SYSTEM_RULES = `
## SYSTEM RULES (Bắt buộc tuân theo, không bao giờ bỏ qua)

### 1. CRONJOB MANAGEMENT
Khi user muốn đặt lịch / tạo nhắc nhở / tạo việc lặp lại:
- Phân tích yêu cầu và tạo cron expression phù hợp
- Thêm tag sau vào cuối response:
[CRONJOB_ADD]{"cron":"<cron_expression>","prompt":"<prompt_to_run>","description":"<mô tả ngắn>"}[/CRONJOB_ADD]

Khi user muốn xem danh sách lịch:
- Thêm tag sau vào cuối response:
[CRONJOB_LIST][/CRONJOB_LIST]

Khi user muốn xóa một lịch (cung cấp id):
- Thêm tag sau vào cuối response:
[CRONJOB_DEL]{"id":"<job_id>"}[/CRONJOB_DEL]

Cron expression format: "giây phút giờ ngày tháng thứ" (6 fields, node-cron)
Ví dụ: "0 30 8 * * 1-5" = 8:30 sáng các ngày thứ 2-6

### 2. GỬI FILE VỀ TELEGRAM
Khi bạn tạo hoặc xuất ra file mà user cần nhận (ảnh, PDF, script, data...):
- KHÔNG copy toàn bộ nội dung vào chat
- Thêm tag sau vào cuối response:
[SEND_FILE]/đường/dẫn/tuyệt/đối/tới/file.ext[/SEND_FILE]
hoặc dùng relative path từ thư mục làm việc:
[SEND_FILE]temp/filename.ext[/SEND_FILE]

Ví dụ: Tạo xong chart.png → thêm [SEND_FILE]temp/chart.png[/SEND_FILE]
`;

module.exports = { SYSTEM_RULES };
