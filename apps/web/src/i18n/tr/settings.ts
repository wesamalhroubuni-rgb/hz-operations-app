import type { CatalogueShape } from '@ops/shared';

import type { settings as enSettings } from '../en/settings';

export const settings: CatalogueShape<typeof enSettings> = {
  description: 'Kuruluş adı ve uygulamaların izlediği kurallar.',
  apiStatus: 'API durumu',
  noApiUrl: 'API adresi yok',
  checkAgain: 'Tekrar kontrol et',
  general: 'Kuruluş',
  rules: 'İş kaydı kuralları',
  name: 'Kuruluş adı',
  slug: 'Giriş kimliği: {{slug}}',
  timeZone: 'Saat dilimi',
  timeZoneHint:
    'Paneldeki, raporlardaki ve dışa aktarımlardaki saatler bu dilimde gösterilir ve "bugün" buna göre sayılır.',
  workLogEditWindowHours: 'Düzenleme süresi (saat)',
  workLogEditWindowHoursHint:
    'Bir iş kaydı oluşturulduktan sonra yazarının onu ne kadar süre değiştirebileceği. En fazla {{max}} saat.',
  offlineMaxBackdateDays: 'Çevrimdışı geriye tarihleme sınırı (gün)',
  offlineMaxBackdateDaysHint:
    'Çevrimdışı kaydedilen yeni bir kaydın kaç gün geriye tarihlenebileceği. 1 ile {{max}} gün arası.',
  submit: 'Ayarları kaydet',
  saved: 'Ayarlar kaydedildi.',
  reset: 'Değişiklikleri geri al',
  needsAdmin: 'Ayarları yalnızca yöneticiler görebilir ve değiştirebilir.',
  errors: {
    required: 'Zorunlu.',
    number: 'Bir sayı girin.',
    range: 'İzin verilen aralığın dışında.',
    wholeNumber: 'Tam sayı girin.',
    timeZone: 'Geçerli bir saat dilimi seçin.',
  },
};
