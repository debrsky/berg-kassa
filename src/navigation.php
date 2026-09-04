<details class="navigation" id="navigation">
    <summary>Меню ▾</summary>
    <nav class="navigation__items" aria-label="Основная навигация">
        <?php if ($path !== '/'): ?>
        <a class="dashboard__link" href="/">Операции</a>
        <?php endif; ?>
        <a class="dashboard__link" href="/references">Справочники</a>
        <a class="dashboard__link" id="audit-link" href="/audit" <?= $pageUser['can_view_protected'] ? '' : 'hidden' ?>>Журнал аудита</a>
        <a class="dashboard__link" id="users-link" href="/users" <?= $pageUser['can_view_protected'] ? '' : 'hidden' ?>>Пользователи</a>
        <hr>
        <button class="dashboard__logout" type="button" id="logout">Выйти</button>
    </nav>
</details>
