import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../platform/auth.js';
import type { AUTH_TEXT, AuthFailureReason, AuthSessionNotice } from './auth-text.js';

// The sign-in, activation and sign-out wording (`auth-text.ts`) in the other languages, so the
// web and mobile catalogues use the same sentences. English stays in `auth-text.ts`.

export interface AuthWording {
  text: Record<keyof typeof AUTH_TEXT, string>;
  failures: Record<AuthFailureReason, string>;
  notices: Record<AuthSessionNotice, string>;
}

const tr: AuthWording = {
  text: {
    signInTitle: 'Giriş yap',
    identifierLabel: 'E-posta, telefon veya kullanıcı adı',
    passwordLabel: 'Parola',
    showPassword: 'Göster',
    hidePassword: 'Gizle',
    showPasswordLabel: 'Parolayı göster',
    hidePasswordLabel: 'Parolayı gizle',
    signIn: 'Giriş yap',
    signingIn: 'Giriş yapılıyor…',
    haveCode: 'Etkinleştirme kodum var',
    retry: 'Tekrar dene',
    activateTitle: 'Parolanızı belirleyin',
    activateIntro:
      'Yöneticinizin verdiği kodu girin ve bir parola seçin. Parola sıfırlama kodu da burada çalışır.',
    codeLabel: 'Etkinleştirme veya sıfırlama kodu',
    newPasswordLabel: 'Yeni parola',
    confirmPasswordLabel: 'Yeni parolayı onaylayın',
    passwordPolicy: `En az ${PASSWORD_MIN_LENGTH} karakter. Hatırlayabileceğiniz uzun bir ifade iyi bir seçimdir.`,
    setPassword: 'Parolayı belirle',
    settingPassword: 'Kaydediliyor…',
    backToSignIn: 'Girişe dön',
    passwordSet: 'Parolanız belirlendi. Şimdi onunla giriş yapın.',
    checkingSession: 'Oturumunuz kontrol ediliyor…',
    signedInAs: 'Giriş yapan',
    signOut: 'Çıkış yap',
    signOutEverywhere: 'Her yerden çıkış yap',
    signingOut: 'Çıkış yapılıyor…',
    signOutEverywhereHint: 'Bu cihaz dahil her cihazdaki oturumlarınızı sonlandırır.',
    identifierRequired: 'E-posta, telefon veya kullanıcı adınızı girin.',
    passwordRequired: 'Parolanızı girin.',
    codeRequired: 'Kodu girin.',
    passwordTooShort: `Parola en az ${PASSWORD_MIN_LENGTH} karakter olmalıdır.`,
    passwordTooLong: `Parola en fazla ${PASSWORD_MAX_LENGTH} karakter olmalıdır.`,
    confirmationRequired: 'Yeni parolayı tekrar yazın.',
    confirmationMismatch: 'İki parola eşleşmiyor.',
  },
  failures: {
    missing_fields: 'E-posta, telefon veya kullanıcı adınızı ve parolanızı girin.',
    invalid_credentials:
      'Giriş bilgileri doğru değil ya da hesap geçici olarak kilitli. Kontrol edip tekrar deneyin.',
    rate_limited: 'Çok fazla deneme. Daha sonra tekrar deneyin.',
    network: 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.',
    invalid_code:
      'Bu kod geçerli değil ya da süresi doldu. Kontrol edin veya yöneticinizden yeni bir kod isteyin.',
    weak_password: 'Farklı bir parola seçin.',
    unexpected: 'Bir şeyler ters gitti. Tekrar deneyin.',
  },
  notices: {
    session_expired: 'Oturumunuz sona erdi. Tekrar giriş yapın.',
    unreachable: 'Oturumunuzu kontrol etmek için sunucuya ulaşılamadı.',
    sign_out_unconfirmed:
      'Bu cihazda çıkış yaptınız, ancak sunucuya ulaşılamadığı için oturum süresi dolana kadar etkin kalabilir. Tekrar çevrimiçi olduğunuzda giriş yapıp yeniden çıkış yapın.',
  },
};

const ar: AuthWording = {
  text: {
    signInTitle: 'تسجيل الدخول',
    identifierLabel: 'البريد الإلكتروني أو الهاتف أو اسم المستخدم',
    passwordLabel: 'كلمة المرور',
    showPassword: 'إظهار',
    hidePassword: 'إخفاء',
    showPasswordLabel: 'إظهار كلمة المرور',
    hidePasswordLabel: 'إخفاء كلمة المرور',
    signIn: 'تسجيل الدخول',
    signingIn: 'جارٍ تسجيل الدخول…',
    haveCode: 'لديّ رمز تفعيل',
    retry: 'إعادة المحاولة',
    activateTitle: 'عيّن كلمة المرور',
    activateIntro:
      'أدخل الرمز الذي أعطاك إياه المسؤول واختر كلمة مرور. يعمل رمز إعادة تعيين كلمة المرور هنا أيضًا.',
    codeLabel: 'رمز التفعيل أو إعادة التعيين',
    newPasswordLabel: 'كلمة المرور الجديدة',
    confirmPasswordLabel: 'تأكيد كلمة المرور الجديدة',
    passwordPolicy: `${PASSWORD_MIN_LENGTH} أحرف على الأقل. العبارة الطويلة التي تتذكرها خيار جيد.`,
    setPassword: 'تعيين كلمة المرور',
    settingPassword: 'جارٍ الحفظ…',
    backToSignIn: 'العودة إلى تسجيل الدخول',
    passwordSet: 'تم تعيين كلمة المرور. سجّل الدخول بها الآن.',
    checkingSession: 'جارٍ التحقق من جلستك…',
    signedInAs: 'تم تسجيل الدخول باسم',
    signOut: 'تسجيل الخروج',
    signOutEverywhere: 'تسجيل الخروج من كل الأجهزة',
    signingOut: 'جارٍ تسجيل الخروج…',
    signOutEverywhereHint: 'ينهي جلساتك على كل الأجهزة، بما فيها هذا الجهاز.',
    identifierRequired: 'أدخل بريدك الإلكتروني أو هاتفك أو اسم المستخدم.',
    passwordRequired: 'أدخل كلمة المرور.',
    codeRequired: 'أدخل الرمز.',
    passwordTooShort: `يجب ألا تقل كلمة المرور عن ${PASSWORD_MIN_LENGTH} أحرف.`,
    passwordTooLong: `يجب ألا تزيد كلمة المرور عن ${PASSWORD_MAX_LENGTH} حرفًا.`,
    confirmationRequired: 'اكتب كلمة المرور الجديدة مرة أخرى.',
    confirmationMismatch: 'كلمتا المرور غير متطابقتين.',
  },
  failures: {
    missing_fields: 'أدخل بريدك الإلكتروني أو هاتفك أو اسم المستخدم وكلمة المرور.',
    invalid_credentials:
      'بيانات الدخول غير صحيحة، أو أن الحساب مقفل مؤقتًا. تحقّق منها ثم أعد المحاولة.',
    rate_limited: 'محاولات كثيرة جدًا. حاول لاحقًا.',
    network: 'تعذّر الوصول إلى الخادم. تحقّق من اتصالك ثم أعد المحاولة.',
    invalid_code:
      'هذا الرمز غير صالح أو منتهي الصلاحية. تحقّق منه، أو اطلب رمزًا جديدًا من المسؤول.',
    weak_password: 'اختر كلمة مرور مختلفة.',
    unexpected: 'حدث خطأ ما. أعد المحاولة.',
  },
  notices: {
    session_expired: 'انتهت جلستك. سجّل الدخول مرة أخرى.',
    unreachable: 'تعذّر الوصول إلى الخادم للتحقق من جلستك.',
    sign_out_unconfirmed:
      'سجّلت الخروج على هذا الجهاز، لكن تعذّر الوصول إلى الخادم، لذا قد تبقى الجلسة فعّالة حتى انتهاء صلاحيتها. سجّل الدخول ثم الخروج مجددًا عند عودة الاتصال.',
  },
};

/** The sign-in wording in Turkish and Arabic, by language code. */
export const AUTH_TRANSLATIONS: { tr: AuthWording; ar: AuthWording } = { tr, ar };
