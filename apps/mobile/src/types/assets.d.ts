// Metro turns an imported image into an asset reference that <Image source> accepts.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}
