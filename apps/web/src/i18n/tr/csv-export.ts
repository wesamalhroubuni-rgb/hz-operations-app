import type { CatalogueShape } from '@ops/shared';

import type { csvExport as enCsvExport } from '../en/csv-export';

export const csvExport: CatalogueShape<typeof enCsvExport> = {
  button: 'CSV olarak dışa aktar',
  exporting: 'Dışa aktarılıyor…',
  hint: 'Yalnızca bu sayfayı değil, geçerli filtrelere uyan tüm satırları dışa aktarır.',
  done: 'Dosya indirildi.',
  tooLarge:
    'Dışa aktarılacak satır sayısı çok fazla: bir dosyaya en fazla {{max}} satır sığar. Filtreleri daraltıp (örneğin daha kısa bir tarih aralığı) tekrar deneyin.',
  forbidden: 'Rolünüz bu listeyi dışa aktaramaz.',
  failed: 'Dışa aktarma başarısız oldu: {{reason}}',
};
