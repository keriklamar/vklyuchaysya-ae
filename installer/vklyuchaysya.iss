; ============================================================
;  Включайся! — установщик (Inno Setup 6)
;  Ставит: CEP-панель в After Effects, проект, шрифты, ключ реестра
;  PlayerDebugMode (чтобы AE грузила неподписанную панель).
;
;  Всё — на уровне ТЕКУЩЕГО пользователя, без прав администратора и
;  без запроса UAC.
;
;  Сборка:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" vklyuchaysya.iss
;  Результат:  installer\Output\Vklyuchaysya_Setup.exe
; ============================================================

#define AppName "Включайся!"
#define AppVersion "1.1.0"
#define AppPublisher "AutoPogoda"

[Setup]
AppId={{B7A1F0C2-9E4D-4B77-9C3E-1A2B3C4D5E6F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
WizardStyle=modern
; всё per-user — админ и UAC не нужны
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={userdocs}\Включайся
DefaultGroupName=Включайся!
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir=Output
OutputBaseFilename=Vklyuchaysya_Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#AppName}
; папка панели относительно .iss: ..\panel\AutoPogodaPanel — берётся в SourceDir
SourceDir=.

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Dirs]
Name: "{userappdata}\Adobe\CEP\extensions"; Flags: uninsneveruninstall

[Files]
; --- CEP-панель (per-user, версия AE значения не имеет) ---
Source: "..\panel\AutoPogodaPanel\*"; DestDir: "{userappdata}\Adobe\CEP\extensions\AutoPogodaPanel"; \
    Flags: recursesubdirs createallsubdirs ignoreversion

; --- MCP-мост (опциональный инструмент разработки/отладки) ---
Source: "..\panel\mcp-bridge-auto.jsx"; DestDir: "{app}\dev"; Flags: ignoreversion

; --- проект After Effects ---
Source: "..\project\*"; DestDir: "{app}\Graph"; Flags: recursesubdirs createallsubdirs ignoreversion
; резервная копия проекта рядом
Source: "..\project\подложка утро_0.3.aep"; DestDir: "{app}\РЕЗЕРВНАЯ КОПИЯ\Graph"; Flags: ignoreversion
Source: "..\project\подложка.psd";           DestDir: "{app}\РЕЗЕРВНАЯ КОПИЯ\Graph"; Flags: ignoreversion

; --- README ---
Source: "README.txt"; DestDir: "{app}"; Flags: isreadme ignoreversion

; --- шрифты (per-user, Win10 1809+) ---
Source: "..\fonts\*.ttf"; DestDir: "{autofonts}"; \
    Flags: onlyifdoesntexist uninsneveruninstall

[Registry]
; PlayerDebugMode — CEP читает ТОЛЬКО из HKCU. Ставим на все ходовые версии CSXS.
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue

[Icons]
Name: "{group}\Проект Включайся (Graph)"; Filename: "{app}\Graph"
Name: "{group}\README"; Filename: "{app}\README.txt"
Name: "{group}\Удалить Включайся!"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\README.txt"; Description: "Открыть README (обязательный шаг настройки в AE)"; \
    Flags: postinstall shellexec skipifsilent nowait

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\AutoPogodaPanel"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    MsgBox(
      'Панель установлена.' + #13#10#13#10 +
      'Последний шаг — один раз в After Effects:' + #13#10 +
      'Edit → Preferences → Scripting & Expressions →' + #13#10 +
      '[x] Allow Scripts to Write Files and Access Network,' + #13#10 +
      'затем перезапустить After Effects.' + #13#10#13#10 +
      'Подробнее — в README.',
      mbInformation, MB_OK);
end;
