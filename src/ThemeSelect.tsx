import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';

export function ThemeSelect() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'system');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('gather-theme', theme);
    } catch {
      // The theme still works when browser storage is unavailable.
    }
  }, [theme]);

  return (
    <label className="theme-select">
      <Moon size={16} aria-hidden="true" />
      <span>Theme</span>
      <select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
