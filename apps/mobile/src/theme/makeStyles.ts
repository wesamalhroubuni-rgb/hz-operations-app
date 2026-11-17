import type { ThemeColors } from '@ops/shared';
import { StyleSheet } from 'react-native';

import { useTheme } from './ThemeProvider';

/**
 * A themed style sheet: `const useStyles = makeStyles((colors) => ({ ... }))` at module level,
 * `const styles = useStyles()` in the component. The sheet is created once per theme and reused,
 * so switching between light and dark costs one `StyleSheet.create` per theme.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<T>,
): () => T {
  const sheets = new Map<ThemeColors, T>();
  function sheetFor(colors: ThemeColors): T {
    let sheet = sheets.get(colors);
    if (sheet === undefined) {
      sheet = StyleSheet.create(factory(colors));
      sheets.set(colors, sheet);
    }
    return sheet;
  }
  return function useStyles(): T {
    return sheetFor(useTheme().colors);
  };
}
