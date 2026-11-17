import type { CatalogueShape } from '@ops/shared';

import type { mapPage as enMapPage } from '../en/map-page';

export const mapPage: CatalogueShape<typeof enMapPage> = {
  description: 'Konum kaydeden son iş kayıtları.',
  mapLabel: 'Son iş kayıtlarının haritası',
  range: '{{from}} ile {{to}} arası',
  defaultRange: 'Tarih filtresi olmadan harita son {{days}} günü gösterir.',
  shown: { one: 'Haritada {{count}} kayıt', other: 'Haritada {{count}} kayıt' },
  truncated:
    '{{total}} kayıttan en yeni {{shown}} tanesi gösteriliyor. Gerisini görmek için filtreleri daraltın.',
  listHeading: 'Haritadaki kayıtlar',
  listCaption: 'Konumlu iş kayıtları',
  openLog: 'Kaydı aç',
  popupPhotos: { one: '{{count}} fotoğraf', other: '{{count}} fotoğraf' },
  empty: 'Bu filtrelere uyan konumlu iş kaydı yok.',
  coordinates: 'Konum',
};
