# مرحله دوم: اتصال واقعی GitHub App و هوش مصنوعی

نسخه: ReviewForge v0.2.0

**نکته امنیتی:** کلید خصوصی، رمز وبهوک، کلید OpenAI و رمز کلاینت GitHub را در چت، تصویر، GitHub Issue یا فایل کد قرار ندهید. آن‌ها را فقط در secrets محیط اجرای خودتان ذخیره کنید.

## وضعیت فعلی

- موتور بررسی و دو حالت `dry-run` و `live` پیاده‌سازی شده‌اند.
- حالت پیش‌فرض `dry-run` است: تحلیل هوش مصنوعی اجرا می‌شود، ولی هیچ کامنتی در GitHub نوشته نمی‌شود.
- تست‌های محلی با پاسخ‌های ساختگی GitHub و OpenAI انجام شده‌اند؛ اتصال به حساب واقعی هنوز تست نشده است.

## قدم ۱ — راه‌اندازی سرور دارای HTTPS

برای دریافت رویدادهای GitHub به یک نشانی عمومی HTTPS احتیاج دارید. `http://localhost:3000` برای دریافت وبهوک‌های مستقیم GitHub کافی نیست.

می‌توانید برنامه را روی سرور دائمی دارای Docker و HTTPS reverse proxy اجرا کنید. از SQLite همراه با Volume پایدار استفاده کنید؛ این نسخه برای اجرای چند نمونه همزمان یا سرورلس طراحی نشده است.

نشانی نمونه زیر را با نشانی سرور خودتان جایگزین کنید:

```env
APP_URL=https://review.example.com
```

## قدم ۲ — ساخت GitHub App

به آدرس زیر بروید:

https://github.com/settings/apps/new

**نام:** `ReviewForge-Dev` (فقط یک پیشنهاد؛ نام باید در GitHub آزاد باشد)

| قسمت در GitHub | مقدار |
|---|---|
| Homepage URL | `https://review.example.com/` |
| User authorization callback URL | `https://review.example.com/auth/github/callback` |
| Setup URL | `https://review.example.com/github/setup` |
| Webhook URL | `https://review.example.com/webhooks/github` |

در بخش Permissions:

- `Contents` → `Read-only`
- `Pull requests` → `Read and write`
- `Issues` → `Read and write` (فقط برای کامنت خلاصه در زمان خطای 422)
- `Metadata` → `Read-only` (پیش‌فرض)

در بخش Subscribe to events:

- `Pull request`
- `Installation`
- `Installation repositories`

**Webhook:** فعال و SSL verification روشن باشد. یک رشته تصادفی قوی برای webhook secret بسازید. بعد از ساخت برنامه، یک private key بسازید، و App ID، App slug، Client ID و Client secret را از پنل GitHub دریافت کنید. قابلیت expiring user access tokens توصیه می‌شود.

برای یک تست ایمن، برنامه را روی مخزن آزمایشی نصب کنید؛ نه مخزن محصول یا سرویس مشتری.

## قدم ۳ — اتصال مدل هوش مصنوعی

از داشبورد سرویس OpenAI، کلید API مخصوص پروژه توسعه ایجاد کنید و سقف هزینه مشخص بگذارید.

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
```

کد منبع در قالب diff به API هوش مصنوعی ارسال می‌شود. قبل از استفاده روی کد خصوصی یا مشتری، مقررات دسترسی، حریم خصوصی و پردازش داده را بررسی کنید. حذف احتمالی tokenها در کد تضمین نمی‌کند هیچ داده حساسی ارسال نشود.

## قدم ۴ — تنظیمات محلی

در PowerShell، در پوشه ReviewForge:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

خروجی دستور دوم را در متغیر `SESSION_SECRET` ذخیره کنید. بقیه مقادیر را فقط در فایل `.env` محلی یا secrets سرور وارد کنید:

```env
SESSION_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=...
OPENAI_API_KEY=...
REVIEW_POST_MODE=dry-run
```

**مهم:** ساختار PEM ممکن است با `BEGIN PRIVATE KEY` نیز شروع شود؛ خط‌های واقعی فایل PEM خودتان را حفظ کنید. واردکردن مقدار ساختگی باعث احراز هویت ناموفق می‌شود.

سپس:

```powershell
npm test
npm run doctor
npm start
```

`npm run doctor` فقط وجود و شکل کلی تنظیمات را بررسی می‌کند؛ با GitHub/OpenAI تماس نمی‌گیرد و کلیدها را چاپ نمی‌کند.

## قدم ۵ — اولین آزمایش با GitHub

1. با گزینه `Sign in with GitHub` وارد ReviewForge شوید.
2. `Install GitHub App` را بزنید و فقط یک مخزن تست انتخاب کنید.
3. در داشبورد `Sync GitHub` را اجرا کنید تا آن مخزن ثبت شود.
4. یک Pull Request **غیردرفت** با تغییر کوچک در مخزن تست باز کنید.
5. GitHub وبهوک امضاشده را ارسال می‌کند، ReviewForge تغییرات را می‌گیرد و مدل AI تحلیل را انجام می‌دهد.
6. در `Reviews` نتیجه را ببینید. در `dry-run` نباید هیچ کامنتی در GitHub ایجاد شده باشد.

اگر خروجی با انتظار شما مطابقت داشت، در تنظیمات سرور:

```env
REVIEW_POST_MODE=live
```

سرویس را مجدداً راه‌اندازی کنید و یک commit **جدید** به همان PR آزمایشی بفرستید تا بررسی جدیدی اجرا شود. این‌بار کامنت در GitHub منتشر می‌شود.

## رفع اشکال سریع

- **نمی‌توان وارد شد:** Client ID، Client secret و آدرس callback را بررسی کنید.
- **مخزن نمایش داده نمی‌شود:** Installation permissions، حساب GitHub و Sync را بررسی کنید.
- **هیچ بررسی شروع نمی‌شود:** وضعیت webhook deliveries در تنظیمات GitHub App، اتصال HTTPS، وجود OpenAI key و لاگ Worker را بررسی کنید.
- **بررسی انجام می‌شود ولی کامنتی وجود ندارد:** ممکن است `REVIEW_POST_MODE=dry-run` باشد؛ یا PR در زمان تحلیل تغییر کرده باشد.
- **خطای 403:** مجوزهای نصب‌شده در GitHub App را بررسی کنید.
- **خطای AI یا قبض بالا:** محدودیت حجم diff، تعداد PRها، کلید OpenAI و سقف هزینه را بررسی کنید.

## قبل از مشتری واقعی

نسخه فعلی هنوز به PostgreSQL، صف پایدار، کنترل هزینه/محدودیت، تنظیمات سازمانی، پشتیبان‌گیری، قوانین حفظ داده، پایش خطا و تست end-to-end با حساب آزمایشی نیاز دارد.
