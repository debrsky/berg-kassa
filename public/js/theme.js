const themeButton = document.querySelector('#theme-toggle');
const themes = ['system', 'light', 'dark'];
const themeLabels = { system: 'Системная', light: 'Светлая', dark: 'Тёмная' };

const themeIcons = {
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4m-4 0h8"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    dark: '<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/>',
};

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    themeButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${themeIcons[theme]}</svg>`;
    themeButton.title = `Тема: ${themeLabels[theme]}`;
    themeButton.setAttribute('aria-label', `Тема: ${themeLabels[theme]}. Нажмите, чтобы переключить`);
}

themeButton.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    setTheme(themes[(themes.indexOf(current) + 1) % themes.length]);
});

setTheme(themes.includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'system');
