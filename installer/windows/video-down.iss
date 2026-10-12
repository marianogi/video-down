; Instalador de video-down para Windows (Inno Setup 6).
; Lo compila installer/build-release.mjs, que antes prepara release/stage-windows con:
;   extension\  native-host\  install.ps1  uninstall.ps1  versions.json  LEEME.txt
;
; Instala por usuario, sin permisos de administrador, en %LOCALAPPDATA%\video-down.
; Tras copiar los ficheros ejecuta install.ps1, que descarga y verifica Deno, ffmpeg y yt-dlp.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\release\stage-windows"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif

#define HostName "dev.marianogutierrez.videodown"

[Setup]
AppId={{6F1C2B0E-5C2A-4B7E-9C66-7A1D2D9E0B11}
AppName=video-down
AppVersion={#AppVersion}
AppVerName=video-down {#AppVersion}
AppPublisher=Mariano Gutiérrez
AppPublisherURL=https://github.com/marianogi/video-down
DefaultDirName={localappdata}\video-down
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=video-down-setup-{#AppVersion}
SetupIconFile=video-down.ico
UninstallDisplayIcon={app}\extension\icons\icon-128.png
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
InfoAfterFile={#StageDir}\LEEME.txt
CloseApplications=no

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
es.RunningScript=Descargando y verificando Deno, ffmpeg y yt-dlp…
en.RunningScript=Downloading and verifying Deno, ffmpeg and yt-dlp…
es.ScriptFailed=No se ha podido completar la instalación del componente nativo (código %1).%n%nRevisa la conexión a Internet y vuelve a ejecutar el instalador. El detalle está en %LOCALAPPDATA%\video-down\logs\install.log.
en.ScriptFailed=The native component could not be installed (code %1).%n%nCheck your Internet connection and run the installer again. Details are in %LOCALAPPDATA%\video-down\logs\install.log.
es.OpenChrome=Abrir chrome://extensions para cargar la extensión
en.OpenChrome=Open chrome://extensions to load the extension
es.OpenFolder=Abrir la carpeta de la extensión
en.OpenFolder=Open the extension folder

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host-manifest.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host-manifest.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host-manifest.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host-manifest.json"; Flags: uninsdeletekey

[Run]
Filename: "{code:ChromePath}"; Parameters: "chrome://extensions"; Description: "{cm:OpenChrome}"; Flags: postinstall nowait skipifsilent; Check: HasChrome
Filename: "{win}\explorer.exe"; Parameters: """{app}\extension"""; Description: "{cm:OpenFolder}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Lo que descarga o genera install.ps1 (Inno solo borra lo que copió él)
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\state"
Type: filesandordirs; Name: "{app}\tmp"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\cache"
Type: filesandordirs; Name: "{app}\deno-cache"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\native-host-manifest.json"
Type: files; Name: "{app}\video-down-host.cmd"
Type: dirifempty; Name: "{app}"

[Code]
function FindChrome(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Result) then
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Result);
end;

function HasChrome(): Boolean;
begin
  Result := FindChrome() <> '';
end;

function ChromePath(Param: String): String;
begin
  Result := FindChrome();
end;

var
  ScriptFailed: Boolean;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('RunningScript');
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') +
              '" -AppDir "' + ExpandConstant('{app}') + '" -SourceDir "' + ExpandConstant('{app}') + '" -NoLaunch';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_SHOW,
                ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    begin
      ScriptFailed := True;
      // SuppressibleMsgBox honours /SUPPRESSMSGBOXES, so silent installs never hang on it.
      SuppressibleMsgBox(FmtMessage(CustomMessage('ScriptFailed'), [IntToStr(ResultCode)]), mbError, MB_OK, IDOK);
    end;
  end;
end;

// Non-zero exit code when the native component could not be installed (useful for silent installs).
function GetCustomSetupExitCode(): Integer;
begin
  if ScriptFailed then
    Result := 10
  else
    Result := 0;
end;
