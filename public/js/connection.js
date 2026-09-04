const connectionRequest = (() => {
    const banners = [document.querySelector('.connection-warning')];
    document.querySelectorAll('dialog').forEach(dialog => {
        const banner = banners[0].cloneNode(true);
        dialog.prepend(banner);
        banners.push(banner);
    });
    const slow = new Set();
    let offline = !navigator.onLine;
    let failure = '';

    function render() {
        const text = offline ? 'Нет подключения к сети.' : slow.size
            ? 'Ответ задерживается. Возможны проблемы с соединением или сервером. Дождитесь результата; не отправляйте изменения повторно.'
            : failure;
        banners.forEach(banner => {
            banner.hidden = !text;
            banner.textContent = text;
        });
    }

    window.addEventListener('offline', () => { offline = true; render(); });
    window.addEventListener('online', () => {
        offline = false;
        failure = 'Сеть появилась. Связь с сервером пока не подтверждена.';
        render();
    });
    render();

    return async (url, options = {}) => {
        const request = {};
        const timer = setTimeout(() => { slow.add(request); render(); }, 10_000);
        const writing = /^(POST|PUT|PATCH|DELETE)$/i.test(options.method || 'GET')
            && /^\/api\/(actions|references|users)(\/|$|\?)/.test(url);
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            offline = false;
            failure = '';
            return { response, data };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            failure = writing
                ? 'Подтверждение изменения не получено. Действие могло выполниться. Проверьте список перед повторной отправкой.'
                : 'Не удалось получить ответ сервера. Возможны проблемы с соединением или сервером.';
            throw new Error(failure, { cause: error });
        } finally {
            clearTimeout(timer);
            slow.delete(request);
            render();
        }
    };
})();
