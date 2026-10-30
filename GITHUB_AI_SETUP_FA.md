# اتصال واقعی ReviewForge به GitHub App و OpenAI — راهنمای محیط فعلی

**به‌روزرسانی: ۳۰ اکتبر ۲۰۲۶ | شاخه توسعه: `work/neon-vercel-bootstrap`**

این راهنما مخصوص نسخه فعلی ReviewForge روی **Vercel + Neon PostgreSQL** است. دستورهای Docker/SQLite نسخه‌های قدیمی را برای انتشار فعلی دنبال نکنید.

## وضعیت تأییدشده

- مخزن: https://github.com/ibboabdoli-ai/reviewforge
- سرویس: https://reviewforge-wzardmn.vercel.app
- انتشار محافظ‌های صف و هزینه در Vercel: READY؛ `/healthz` پاسخ ۲۰۰ و دیتابیس ready برگردانده است.
- `APP_URL` در Vercel روی همین آدرس تنظیم شده است.
- `GITHUB_APP_ID`، `GITHUB_APP_SLUG` و `GITHUB_CLIENT_ID` موجودند. نام App: `reviewforge-ibbo-dev`.
- `GITHUB_CLIENT_SECRET`، `GITHUB_PRIVATE_KEY` و `GITHUB_WEBHOOK_SECRET` در Production تنظیم شده‌اند و اتصال OAuth و بررسی PR آزمایشی با همین GitHub App موفق بوده است.
- `DATABASE_URL` و `SESSION_SECRET` و `WORKER_SECRET` در پروژه ثبت شده‌اند؛ مقادیر مخفی را آشکار نکنید.
- `REVIEW_POST_MODE=dry-run` و `AI_REVIEW_ENABLED=false`. بنابراین **هیچ بررسی پولی و هیچ کامنت خودکاری نباید فعال باشد**.
- `OPENAI_API_KEY` به‌صورت محرمانه ثبت شده و در آزمایش PR آزمایشی کار کرده است. دو تست dry-run و live هر کدام ۳ ایراد عمدی را پیدا کردند؛ در تست live یک Review و ۳ کامنت خطی در GitHub ثبت شد.
- برای جلوگیری از مصرف ناخواسته، هوش مصنوعی دوباره غیرفعال شد؛ `AI_ALLOWED_REPOSITORIES=ibboabdoli-ai/reviewforge-sandbox` و `AI_DAILY_REQUEST_LIMIT=2` فقط اجازه ۲ تلاش مدل در روز UTC می‌دهند.
- مسیر بازیابی `GET /internal/process-queue` فقط با `CRON_SECRET` معتبر باز است؛ Vercel Cron روزانه ساعت ۰۴:۰۰ UTC تعریف شده، اما وقوع اولین اجرای زمان‌بندی‌شده هنوز تأیید نشده است.
- پرداخت Stripe هنوز فعال نشده است. این نسخه هنوز آماده فروش عمومی نیست.

## ۱. نشانی‌های GitHub App را بدون ساخت App جدید تطبیق بدهید

در GitHub وارد **Settings → Developer settings → GitHub Apps → reviewforge-ibbo-dev** شوید:

| فیلد | مقدار دقیق |
| --- | --- |
| Homepage URL | `https://reviewforge-wzardmn.vercel.app/` |
| User authorization callback URL | `https://reviewforge-wzardmn.vercel.app/auth/github/callback` |
| Setup URL | `https://reviewforge-wzardmn.vercel.app/github/setup` |
| Webhook URL | `https://reviewforge-wzardmn.vercel.app/webhooks/github` |

Webhook را روشن و **SSL verification** را فعال نگه دارید.

Repository permissions:
- **Contents**: Read-only
- **Pull requests**: Read and write
- **Issues**: Read and write (برای fallback summary comment)
- **Metadata**: Read-only

Subscribe to events: **Pull request**, **Installation**, **Installation repositories**.

**هشدار:** مقدار Webhook secret در GitHub App و `GITHUB_WEBHOOK_SECRET` در Vercel باید دقیقاً یکسان باشد. Private Key و Client Secret نیز باید متعلق به همین App باشند. کلیدها را در چت، لاگ، ریپازیتوری یا تصویر منتشر نکنید؛ فقط در Secret/Environment Variables سرور وارد کنید.

## ۲. تنظیمات Vercel را بررسی کنید

مسیر: Vercel → project **reviewforge** → Settings → Environment Variables.

در محیط Production نام‌های زیر باید وجود داشته باشند:
`APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `WORKER_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.

نکته: صرف وجود اسم یک متغیر به‌معنای معتبر بودن مقدارش نیست. اگر مقدار رمزدار را اصلاح کردید، انتشار جدید لازم است تا Runtime نسخه جدید آن را دریافت کند. **بدون نیاز کلید را دوباره تولید نکنید**.

فعلاً این دو مقدار باید تغییر نکنند:

```env
REVIEW_POST_MODE=dry-run
AI_REVIEW_ENABLED=false
```

## ۳. ورود واقعی GitHub را تست کنید

1. از https://reviewforge-wzardmn.vercel.app بازدید کنید.
2. **Sign in with GitHub** را بزنید و ورود را کامل کنید.
3. اگر با خطای 503 مواجه شدید، Client Secret و callback URL را تطبیق دهید.
4. پس از ورود، بررسی کنید Dashboard باز شود و بتوانید صفحه Repositories را ببینید.

**تا قبل از موفقیت ورود، App را روی هیچ مخزن کاری نصب نکنید.**

## ۴. نصب امن GitHub App

1. از Dashboard گزینه **Install GitHub App** را بزنید.
2. فقط یک مخزن آزمایشی غیرمهم را با **Only select repositories** انتخاب کنید.
3. در Dashboard گزینه **Sync GitHub** را بزنید.
4. در GitHub App Settings → **Advanced → Recent Deliveries** ارسال‌های وبهوک را بررسی کنید. برای payload معتبر، پاسخ قابل انتظار از ReviewForge معمولاً HTTP `202` است.
5. ابتدا صرفاً یک PR آزمایشی غیر Draft باز کنید. **تا قبل از فعال‌سازی AI، قرار نیست Review هوشمند ساخته شود**.

## ۵. فعال‌کردن هوش مصنوعی، تنها برای آزمایش کنترل‌شده

1. در OpenAI یک **API Key مجزا برای توسعه** و سقف هزینه مشخص ایجاد کنید.
2. آن را **مستقیماً در Vercel** به‌صورت Secret با کلید `OPENAI_API_KEY` ذخیره کنید.
3. تا قبل از تأیید ورود، نصب، رویداد وبهوک و بررسی صف، `AI_REVIEW_ENABLED` را تغییر ندهید.
4. بعد از تأیید، با مجوز مالک و سقف هزینه پایین، `AI_REVIEW_ENABLED=true` را فعال و نسخه جدید را منتشر کنید؛ `REVIEW_POST_MODE=dry-run` باقی بماند.
5. یک PR آزمایشی جدید باز کنید، گزارش را در داشبورد بررسی و تأیید کنید که **هیچ کامنتی در GitHub منتشر نشده است**.

محتوای Diff به سرویس هوش مصنوعی ارسال می‌شود. روی کد مشتری یا اطلاعات حساس بدون بازبینی حریم خصوصی تست نکنید.

## ۶. پیش‌شرط‌های حالت LIVE

تنها پس از موفقیت آزمایش dry-run، بررسی زمان‌بندی و بازیابی Jobها، محدودکردن هزینه، و تأیید مالک می‌توان `REVIEW_POST_MODE=live` را در محیط آزمایش فعال کرد. یک Commit جدید روی PR آزمایشی ایجاد کنید و بررسی کنید که نتیجه مرتبط با همان HEAD منتشر شود.

برای سرورلس، پردازش فوری با `waitUntil` انجام می‌شود. بازیابی روزانه با Vercel Cron و `CRON_SECRET` تعریف شده، و فراخوانی دستی محافظت‌شده با `POST /internal/process-queue` و `WORKER_SECRET` ممکن است. تا زمان تأیید اجرای واقعی Cron و تست بازیابی Job معوق، قابلیت بازیابی را کامل تلقی نکنید. در پلن Hobby زمان‌بندی بیشتر از یک بار در روز پذیرفته نمی‌شود؛ محدودیت روزانه تعداد درخواست‌ها به‌معنای سقف قطعی مبلغ دلار نیست.

## ۷. پرداخت و عرضه عمومی

فعلاً Stripe، اشتراک پولی و نصب روی مخزن‌های مشتری **غیرفعال بمانند**. ابتدا GitHub OAuth و webhook و صف و AI را تست کنید؛ سپس Stripe Test Mode، کنترل امنیت کاربران، مدیریت داده، حریم خصوصی و پایش هزینه را تکمیل کنید.

## چک‌لیست اعتبارسنجی

- [x] ورود GitHub موفق
- [x] نصب App فقط روی مخزن تست
- [x] Sync installations موفق
- [x] دریافت Webhook امضاشده
- [x] بررسی واقعی در حالت dry-run و بدون کامنت
- [x] تست موقت live روی مخزن آزمایشی و ثبت ۳ کامنت خطی
- [x] بازگشت به `AI_REVIEW_ENABLED=false` و `REVIEW_POST_MODE=dry-run`
- [x] سقف روزانه اتمیک و محدودیت مخزن آزمایشی
- [x] مسیر بازیابی بدون رمز به HTTP 403 پاسخ می‌دهد
- [ ] مشاهده اجرای واقعی Cron و تست بازیابی پس از شکست
- [ ] رصد هزینه، امنیت چندمستاجری و فعال‌سازی Stripe Test Mode

**هیچ کلید خصوصی را از طریق چت ارسال نکنید.**

### Proffera CodeRabbit fallback subscription

To enable the quota-triggered ReviewForge fallback, visit the GitHub App settings for `ReviewForge-Ibbo-Dev`, open **Permissions & events → Subscribe to events**, enable **Issue comment**, save and accept requested installation permissions if GitHub asks. Keep `Pull request`, `Installation` and `Installation repositories` enabled. No issue-comment trigger means no fallback, even when `AI_FALLBACK_ONLY_REPOSITORIES` is set. `ReviewForge` stays in dry-run without review comments or automatic merges.
