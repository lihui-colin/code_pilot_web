#!/bin/bash
#!/bin/bash
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE TERM_PROGRAM
exec code-server --bind-addr 0.0.0.0:8020
