# Berg Kassa WebUI

Read-only WebUI для просмотра операций из PostgreSQL `berg_kassa`, схема `vl`.

## Запуск

```powershell
.\.tools\php\php.exe bin\create-user.php
$password = Read-Host 'Пароль пользователя' -AsSecureString
$env:NEW_USER_PASSWORD = [Net.NetworkCredential]::new('', $password).Password
.\.tools\php\php.exe bin\create-user.php admin vl,company_2 1
Remove-Item Env:NEW_USER_PASSWORD
.\php.cmd -S 127.0.0.1:8080 -t public public\router.php
```

После запуска откройте <http://127.0.0.1:8080>.

Схемы перечисляются через запятую в команде и сохраняются как PostgreSQL-массив
`text[]` в `auth.users.data_schema`. Последний аргумент команды управляет доступом к
защищённым операциям: `1` — доступ разрешён, `0` — запрещён. Команда также
обновляет существующего пользователя с тем же логином.

Приложение читает подключение к PostgreSQL из `.env`. Для повторного импорта
данных из MSSQL:

```powershell
python -m pip install -r requirements.txt
python migrate_trading.py --apply
```

## Проверка без изменения данных

```powershell
python migrate_trading.py
.\.tools\php\php.exe -l src\app.php
.\.tools\php\php.exe -l public\index.php
node --check public\js\app.js
node --check public\js\login.js
```
