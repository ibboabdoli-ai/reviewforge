# شروع بررسی هوشمند ReviewForge (امن)

## وضعیت فعلی
- ورود GitHub، نصب GitHub App و اتصال مخزن موفق شده‌اند.
- موتور بررسی با داده ساختگی آزمایش شده است.
- مدل OpenAI واقعی هنوز به حساب صاحب برنامه متصل نیست.
- `REVIEW_POST_MODE=dry-run`: **هیچ کامنتی در GitHub ثبت نمی‌شود.**
- `AI_REVIEW_ENABLED=false`: **حتی با ثبت کلید، خودکار هزینه API ایجاد نمی‌شود.**

## آماده کردن OpenAI API
1. به https://platform.openai.com/api-keys بروید.
2. در یک **Project مخصوص ReviewForge** کلید بسازید.
3. در Project → Limits یک سقف مصرف ماهانه کم (مثلاً ۵ دلار) و **Enforce a hard limit** انتخاب کنید. سقف محافظتی ممکن است با اندکی تأخیر اجرا شود.
4. در Vercel → wzardmn → reviewforge → Settings → Environment Variables، متغیر `OPENAI_API_KEY` را به‌صورت Sensitive **فقط در Production** ذخیره کنید.
5. مدل `OPENAI_MODEL=gpt-4.1-mini` از قبل در کد پیش‌فرض است.
6. برای اعمال کلید، پروژه باید دوباره deploy شود.
7. پس از تأیید کلید و آزمون مخزن آزمایشی، `AI_REVIEW_ENABLED=true` را جداگانه فعال و دوباره deploy کنید.

## اجرای اولین آزمون
- یک Pull Request کوچک **غیر Draft** روی مخزن تستی ثبت کنید.
- با روشن بودن `AI_REVIEW_ENABLED=true` وبهوک، اجرای کار پس از پاسخ و سپس ذخیره نتیجه در Neon را راه می‌اندازد.
- نتیجه در **Code reviews** نمایش داده می‌شود و باید `posted=0` باشد.
- در صورت خطای موقت، کار در صف Neon باقی می‌ماند. این MVP هنوز زمان‌بند بازیابی مستقل ندارد؛ برای محیط تجاری باید اضافه شود.

## اطلاعات امنیتی
- فایل‌های خصوصی، کلید API و رمزها را در چت یا GitHub قرار ندهید.
- نسخه فعلی بعضی قالب‌های رایج توکن را از diff حذف می‌کند اما تضمین نمی‌کند همه اسرار در کد حذف شوند؛ ابتدا فقط مخزن آزمایشی را استفاده کنید.
- ChatGPT و OpenAI API صورتحساب جدا دارند؛ اعتبار ChatGPT به‌تنهایی به‌معنای API رایگان نیست.

مستندات:
- https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
- https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform
- https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
