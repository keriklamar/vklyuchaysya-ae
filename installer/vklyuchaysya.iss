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
#define AppVersion "1.1.7"
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
; явно показываем страницу выбора папки установки (проект + резервная
; копия ставятся туда; панель и шрифты — всегда в фиксированные системные
; места, от выбора папки не зависят)
DisableDirPage=no
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

; --- пресет Adobe Media Encoder "строка" — зашит в инсталлятор, но не
; раскладывается сюда автоматически: целевых папок несколько (по числу
; версий AME на машине) и заранее неизвестно, сколько их — раскладка
; сделана в [Code] (см. InstallAmePreset). ---
Source: "extras\Stroka_VKL.epr"; DestDir: "{tmp}"; Flags: dontcopy

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
// Версия AME на диске — папка вида "22.0", "23.0", "26.0" (всегда
// начинается с цифры). Рядом в Documents\Adobe\Adobe Media Encoder\ может
// лежать и другое (напр. "Adobe Adobe Media Encoder Audio Previews") —
// это НЕ версия, туда пресет класть не нужно.
function LooksLikeAmeVersion(const AName: string): Boolean;
begin
  Result := (Length(AName) > 0) and (AName[1] >= '0') and (AName[1] <= '9');
end;

// Раскладывает Stroka_VKL.epr во ВСЕ версии Adobe Media Encoder, найденные
// на этой машине (Documents\Adobe\Adobe Media Encoder\<версия>\Presets),
// и дополнительно всегда в "26.0" (текущая версия, на которой сделан
// пресет) — даже если такой папки ещё нет (создастся сама при первом
// запуске AME, но пресет туда уже положен заранее).
procedure InstallAmePreset;
var
  baseDir, destDir, srcTmp: string;
  found: TFindRec;
begin
  ExtractTemporaryFile('Stroka_VKL.epr');
  srcTmp := ExpandConstant('{tmp}\Stroka_VKL.epr');
  baseDir := ExpandConstant('{userdocs}\Adobe\Adobe Media Encoder');

  if DirExists(baseDir) then
  begin
    if FindFirst(baseDir + '\*', found) then
    begin
      try
        repeat
          if (found.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0)
             and (found.Name <> '.') and (found.Name <> '..')
             and LooksLikeAmeVersion(found.Name) then
          begin
            destDir := baseDir + '\' + found.Name + '\Presets';
            ForceDirectories(destDir);
            CopyFile(srcTmp, destDir + '\Stroka_VKL.epr', False);
          end;
        until not FindNext(found);
      finally
        FindClose(found);
      end;
    end;
  end;

  // Всегда также в 26.0 — по решению пользователя, даже если её не было
  // среди найденных выше (например, на совсем свежей машине).
  destDir := baseDir + '\26.0\Presets';
  ForceDirectories(destDir);
  CopyFile(srcTmp, destDir + '\Stroka_VKL.epr', False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InstallAmePreset;
    MsgBox(
      'Панель установлена.' + #13#10#13#10 +
      'Последний шаг — один раз в After Effects:' + #13#10 +
      'Edit → Preferences → Scripting & Expressions →' + #13#10 +
      '[x] Allow Scripts to Write Files and Access Network,' + #13#10 +
      'затем перезапустить After Effects.' + #13#10#13#10 +
      'Подробнее — в README.',
      mbInformation, MB_OK);
  end;
end;
