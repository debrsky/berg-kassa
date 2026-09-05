@echo off
"%~dp0php.cmd" -S 127.0.0.1:8080 -t "%~dp0public" "%~dp0public\router.php"
