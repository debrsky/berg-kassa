const themeButton = document.querySelector('#theme-toggle');
const themes = ['system', 'light', 'dark'];
const themeLabels = { system: 'Системная', light: 'Светлая', dark: 'Тёмная' };

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    themeButton.textContent = `Тема: ${themeLabels[theme]}`;
    themeButton.setAttribute('aria-label', `Тема: ${themeLabels[theme]}. Нажмите, чтобы переключить`);
}

themeButton.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    setTheme(themes[(themes.indexOf(current) + 1) % themes.length]);
});

setTheme(themes.includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'system');
