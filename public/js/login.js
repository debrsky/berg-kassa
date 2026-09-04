const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');

form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
        const { response, data } = await connectionRequest('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        if (!response.ok) throw new Error(data.error || 'Ошибка входа');
        location.replace('/');
    } catch (failure) {
        error.textContent = failure.message;
        button.disabled = false;
    }
});
