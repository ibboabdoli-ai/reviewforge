# ReviewForge v0.3 — راه‌اندازی مستقل Vercel + Neon

## وضعیت ثبت‌شده در 2026-10-29

- Vercel team: `wzardmn`
- Vercel project: `reviewforge`
- Project ID: `prj_70oyrQewWkDVuZ3X65B8TPeqzUEn`
- Framework: `node`, Node `24.x`, Function region `fra1`
- Env: `REVIEW_POST_MODE=dry-run` و `DEMO_MODE=false` روی Preview/Production
- هنوز Git repository به پروژه متصل نشده و Deployment ساخته نشده است.
- Neon database ایجاد نشده؛ سازمان Neon فعلی توسط Vercel مدیریت می‌شود و API مستقل خطای `action restricted` برگرداند. دیتابیس فعلی و سایر پروژه‌ها دست نخورده‌اند.

## قدم ۱ — مخزن جدید (Private)

در GitHub مخزن `reviewforge` را با مالکیت شخصی، به‌صورت **Private** بسازید. محتویات ZIP همین نسخه را در آن Commit/Push کنید. فایل `.env` و کلید خصوصی را هرگز Commit نکنید. از `main` محافظت کنید و در CI ابتدا تست اجرا شود.

## قدم ۲ — وصل کردن Git Repository

در Vercel، پروژه `wzardmn/reviewforge` را باز کنید، Settings → Git و مخزن جدید را وصل کنید. تا تنظیم DATABASE_URL و APP_URL و SESSION_SECRET، deploy نکنید؛ یا Preview را خصوصی نگه دارید.

## قدم ۳ — ساخت دیتابیس مستقل با Vercel Marketplace

از داخل پروژه Vercel در Storage / Marketplace، یک Neon database **جدید** با نام reviewforge انتخاب کنید. دیتابیس دیگر پروژه‌ها را Reuse نکنید. قبل از تأیید، پلن و هزینه را در صفحه پرداخت بررسی کنید. این روش برای سازمان Neon مدیریت‌شده توسط Vercel مناسب است.

در محیطی که Vercel CLI لاگین شده است می‌توان از دستور زیر استفاده کرد (ممکن است مرحله تأیید پلن/هزینه داشته باشد):

```bash
vercel integration add neon
```

باید متغیر `DATABASE_URL` به پروژه ReviewForge وصل شود؛ برای schema migration از URL مستقیم و غیر pooled استفاده کنید. کلیدها را در داشبورد ذخیره کنید و در چت نفرستید.

## قدم ۴ — اجرای migration در دیتابیس جدید

فایل `migrations/001_initial.sql` را تنها روی دیتابیس **جدید ReviewForge** اجرا کنید. مسیر مجاز: Neon SQL Editor یا اتصال PostgreSQL مستقیم.

## قدم ۵ — Environment Variables

بخشی از متغیرها در فایل `.env.example` توضیح داده شده‌اند. برای Vercel ضروری هستند:

```text
APP_URL=https://YOUR_ACTUAL_DEPLOYMENT_OR_DOMAIN
DATABASE_URL=postgresql://...  (do not paste here)
SESSION_SECRET=(random 32+ characters)
REVIEW_POST_MODE=dry-run
DEMO_MODE=false
WORKER_SECRET=(independent random 32+ characters)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_PRIVATE_KEY=...
GITHUB_WEBHOOK_SECRET=...
OPENAI_API_KEY=...
```

`NODE_ENV=production` روی Vercel برقرار است. `APP_URL` باید دقیقاً با Origin بازشده در مرورگر برابر باشد تا فرم‌ها در کنترل CSRF رد نشوند. یک دامنه ثابت production بهترین گزینه برای GitHub callback است؛ Preview URL متغیر می‌تواند callback را خراب کند.

## قدم ۶ — webhook و Worker

ساخت GitHub App: Callback `APP_URL/auth/github/callback`، setup `APP_URL/github/setup` و webhook `APP_URL/webhooks/github`.

GitHub App به permissions حداقلی نیاز دارد: Contents read, Pull requests read/write, Issues write, Metadata read. فقط روی مخزن آزمایشی نصب کنید.

⚠️ پروژه Vercel فعلاً با SSO Deployment Protection ایجاد شده؛ GitHub/Stripe webhooks تا زمان فعال‌سازی دسترسی لازم به URL عمومی نمی‌رسند. **قبل از فعال‌سازی webhook** یا production URL را عمومی کنید و Preview را محافظت‌شده نگه دارید، یا مسیر امن Bypass برای automation را تنظیم کنید. از قراردادن توکن‌های Bypass در log و فایل‌ها خودداری کنید.

Worker در مسیر `POST /internal/process-queue` است و `Authorization: Bearer <WORKER_SECRET>` می‌خواهد. این نسخه روی Vercel **کرون فعال ندارد**، چون قبل از تست هزینه و تحویل رویداد نباید پردازش خودکار فعال شود. بعد از تست، Vercel Cron یا صف دائمی با lock و retry مناسب اضافه شود. تا آن زمان فقط رویدادها به صف می‌روند و برای اجرای پردازش نیاز به trigger امن است.

## قدم ۷ — پرداخت

Stripe فقط Test mode، بعد از بررسی امنیت webhook و اشتراک کاربران. فعال‌سازی plan منوط به webhook تأییدشده است. برای فروش عمومی باید رویدادهای خارج از ترتیب، لغو اشتراک، محدودیت نرخ و مدیریت هزینه‌ها بررسی شوند.

## محدودیت‌های MVP

- adapter PostgreSQL آماده است، اما اتصال به Neon زنده هنوز تست نشده است.
- SQLite برای تست محلی باقی مانده؛ production بدون DATABASE_URL اصلاً بالا نمی‌آید.
- قفل اتمیک برای گرفتن کار و بازیابی کارهای قدیمی اضافه شده، اما تضمین دقیق یک‌بار انتشار کامنت بعد از Crash هنوز تکمیل نیست؛ `REVIEW_POST_MODE=live` را فعال نکنید.
- اجرای E2E با GitHub App/Stripe قبل از عرضه عمومی اجباری است.

## وضعیت واقعی اتصال‌ها در ۲۹ اکتبر ۲۰۲۶

- Vercel project `reviewforge`: ساخته شد، framework `node` و Node 24 و Region فرانکفورت.
- `SESSION_SECRET` و `WORKER_SECRET`: به‌صورت رمزگذاری‌شده در Vercel برای development/preview/production ذخیره شد.
- `REVIEW_POST_MODE=dry-run` و `DEMO_MODE=false`: در محیط‌های استقرار تنظیم شده‌اند.
- دیتابیس جدید Neon: انجام نشده؛ تنها سازمان Neon متصل، متعلق به `Vercel: wzardmn` است و create_project پیام `organization is managed by Vercel` برگرداند.
- بررسی Vercel integration list نیز با 403 (Forbidden) رد شد؛ ابزار متصل امکان نصب مستقیم marketplace resource ارائه نمی‌کند.
- GitHub repository: هنوز ساخته نشده؛ ابزار متصل GitHub امکان create_repository ارائه نمی‌کند.
- Vercel deployment: هنوز انجام نشده؛ بدون دیتابیس و APP_URL مناسب، اجرای production نادرست است.
- Remote Desktop Commander: هر دو دستگاه متصل در زمان بررسی آفلاین بودند.

پس از اتصال دیتابیس Neon و ایجاد GitHub repo با مجوزهای مناسب می‌توان به‌صورت امن ادامه داد. هیچ کلید محرمانه‌ای نباید داخل مخزن، ZIP یا گفتگو ذخیره شود.
