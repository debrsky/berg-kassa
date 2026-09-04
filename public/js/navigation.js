const navigation = document.querySelector('#navigation');

document.addEventListener('click', event => {
    if (!navigation.contains(event.target) || event.target.closest('a, button')) navigation.open = false;
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navigation.open) {
        navigation.open = false;
        navigation.querySelector('summary').focus();
    }
});
