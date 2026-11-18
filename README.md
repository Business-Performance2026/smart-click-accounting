# نظام الإدارة والمحاسبة والمخزون — SMART CLICK

برنامج ويب للمبيعات والمشتريات والمخزون وعروض الأسعار والسندات، يعمل على الجوال والكمبيوتر، بقاعدة بيانات Firebase واستضافة GitHub Pages.

## الملفات

| الملف | الوصف |
|---|---|
| `index.html` | برنامج الموظفين (يحتاج تسجيل دخول) |
| `portal.html` | صفحة العميل الخاصة (رابط سري لكل عميل، بدون تسجيل دخول) |
| `fb.js` | تحميل Firebase |
| `firebase-config.js` | إعدادات ربط مشروع Firebase |
| `firestore.rules` | قواعد الحماية — تُلصق في Firebase Console |

## الإعداد (مرة واحدة)

1. **Firebase → Authentication → Sign-in method:** فعّل Email/Password.
2. **Firebase → Authentication → Settings → Authorized domains:** أضف `business-performance2026.github.io`.
3. **Firebase → Firestore Database → Rules:** الصق محتوى `firestore.rules` كاملاً ثم **Publish**.
4. **GitHub → Settings → Pages:** Source = Deploy from a branch، Branch = `main` / `(root)`.
5. افتح رابط البرنامج، أنشئ حسابك، واضغط **"نعم، أنا المالك"** — أول حساب يسجّل يصبح المالك.

## الموظفون

من **الإعدادات ← المستخدمون والصلاحيات** أضف بريد الموظف وصلاحيته (مدير / موظف / مشاهد).
الموظف يفتح الرابط ← "موظف جديد؟ أنشئ حساباً" بنفس البريد ← يؤكد بريده ← يدخل.

## رابط العميل

من صفحة العميل ← **رابط العميل الخاص**. الرابط سري وطويل، ولا يعرض إلا بيانات هذا العميل، ويتحدّث تلقائياً عند إضافة فاتورة أو دفعة له.
لإيقاف رابط قديم: **إلغاء الرابط وإنشاء جديد**.

## الحماية

- إعدادات `firebase-config.js` ليست سرية؛ الحماية كلها في `firestore.rules`.
- لا ترفع أي نسخة احتياطية أو بيانات عملاء إلى هذا المستودع (المستودع عام).

## الإرسال التلقائي بالإيميل (خطة Blaze)
1. Firebase ← Extensions ← ثبّت **Trigger Email from Firestore**.
2. Email documents collection: `mail` — SMTP connection URI: `smtps://Smartclick.om%40gmail.com@smtp.gmail.com:465` مع كلمة مرور التطبيق في خانة SMTP password.
3. Default FROM: `SMART CLICK <Smartclick.om@gmail.com>`.
4. الصق `firestore.rules` في Firebase ← Firestore ← Rules ← Publish.
5. في البرنامج: الإعدادات ← فعّل "إرسال الإيميل تلقائياً من البرنامج مع PDF مرفق".

## الإشعارات (حتى لو التطبيق مغلق) — رفع مرة واحدة من الكمبيوتر
1. ثبّت **Node.js** (نسخة LTS) من nodejs.org.
2. من GitHub: Code ← Download ZIP، وفك الضغط.
3. افتح نافذة الأوامر داخل المجلد (ويندوز: اكتب `cmd` في شريط العنوان واضغط Enter)، ثم:
   ```
   npm install -g firebase-tools
   firebase login
   cd functions
   npm install
   cd ..
   firebase deploy --only functions,firestore:rules
   ```
4. Firebase ← إعدادات المشروع ← Cloud Messaging ← Web Push certificates ← **Generate key pair**، وانسخ المفتاح.
5. في البرنامج: الإعدادات ← الإشعارات ← «إعداد المدير» ← الصق المفتاح ← حفظ ← **تفعيل الإشعارات** على كل جهاز.

## موصّل Claude (نفس خطوة الرفع أعلاه)
1. في البرنامج: الإعدادات ← 🤖 موصّل Claude ← **إنشاء رابط الموصّل** ← نسخ الرابط.
2. في claude.ai: الإعدادات ← Connectors ← Add custom connector ← الاسم `SMART CLICK` والصق الرابط.
3. الرابط سري: إذا انكشف، اضغط «تغيير الرابط» وحدّثه في claude.ai.
