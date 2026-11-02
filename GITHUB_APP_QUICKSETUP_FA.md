# ساخت GitHub App برای ReviewForge — مرحله آزمایشی

## ۱. باز کردن فرم از پیش تنظیم‌شده
[بازکردن فرم ساخت GitHub App](https://github.com/settings/apps/new?name=ReviewForge-Ibbo-Dev&description=Automated+pull+request+review+for+ReviewForge+test+repositories&url=https%3A%2F%2Freviewforge-wzardmn.vercel.app&callback_urls%5B%5D=https%3A%2F%2Freviewforge-wzardmn.vercel.app%2Fauth%2Fgithub%2Fcallback&webhook_active=true&webhook_url=https%3A%2F%2Freviewforge-wzardmn.vercel.app%2Fwebhooks%2Fgithub&request_oauth_on_install=false&public=false&contents=read&pull_requests=write&issues=write&events%5B%5D=pull_request&events%5B%5D=installation&events%5B%5D=installation_repositories)

این لینک طبق URL parameterهای رسمی GitHub تنظیمات زیر را پر می‌کند. قبل از ذخیره آن‌ها را بررسی کنید:

- **Name:** ReviewForge-Ibbo-Dev (در صورت اشغال بودن، اسم دیگری انتخاب کنید)
- **Homepage:** https://reviewforge-wzardmn.vercel.app/
- **Callback URL:** https://reviewforge-wzardmn.vercel.app/auth/github/callback
- **Webhook URL:** https://reviewforge-wzardmn.vercel.app/webhooks/github
- **Webhook Active:** روشن
- **Request user authorization during installation:** خاموش (ابتدا از وب‌سایت وارد می‌شویم)
- **Where can this GitHub App be installed?:** Only on this account
- **Contents:** Read-only
- **Pull requests:** Read and write
- **Issues:** Read and write (برای پیام خلاصه در صورت خطای inline)
- **Events:** Pull request; Installation; Installation repositories
- **SSL verification:** روشن

## ۲. ساخت رمز امن وبهوک
در قسمت Webhook secret، یک رمز تصادفی ۳۲ بایت یا بیشتر وارد کنید. آن را در چت، فایل‌های مخزن، Issue، اسکرین‌شات یا متن PR نفرستید.

بعد از تأیید **Create GitHub App**، در تنظیمات App یک **Client secret** بسازید و یک **Private key** دانلود کنید. فایل PEM را خصوصی نگه دارید.

## ۳. افزودن تنظیمات به Vercel
در Vercel → team wzardmn → reviewforge → Settings → Environment Variables، فقط برای پروژه ReviewForge این شش متغیر را تعریف کنید:

- `GITHUB_APP_ID` — App ID (غیرمحرمانه)
- `GITHUB_APP_SLUG` — نام slug برنامه، مثل `reviewforge-ibbo-dev` (غیرمحرمانه)
- `GITHUB_CLIENT_ID` — Client ID (غیرمحرمانه)
- `GITHUB_CLIENT_SECRET` — Client secret (**Encrypted/Sensitive**)
- `GITHUB_PRIVATE_KEY` — تمام متن فایل PEM با خطوط اصلی (**Encrypted/Sensitive**)
- `GITHUB_WEBHOOK_SECRET` — همان رمز ثبت‌شده برای وبهوک (**Encrypted/Sensitive**)

پروژه در Vercel از قبل `APP_URL`، `DATABASE_URL` و `SESSION_SECRET` دارد؛ آن‌ها را دست نزنید. بعد از تنظیم کلیدها، deploy مجدد لازم است.

## ۴. تست امن
1. از سایت ReviewForge گزینه ورود با GitHub را بزنید.
2. GitHub App را فقط روی یک مخزن تست نصب کنید.
3. نصب را با گزینه Sync GitHub در داشبورد همگام کنید.
4. تست وبهوک را در GitHub App → Advanced → Recent Deliveries بررسی کنید.
5. `REVIEW_POST_MODE=dry-run` باقی بماند و بدون کلید AI هیچ بررسی واقعی اجرا نشود.

**وضعیت:** ساخت GitHub App و افزودن کلیدها هنوز به اقدام مالک حساب نیاز دارد. این فایل به معنی فعال‌شدن اتصال نیست.

منبع: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
