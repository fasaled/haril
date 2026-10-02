/**
 * Shell completion script printer.
 */

const SCRIPTS: Record<string, string> = {
  bash: `#!/usr/bin/env bash
# haril bash completion
_haril() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  words=(\"\${COMP_WORDS[@]:1}\")
  cword=\$((COMP_CWORD-1))

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "--version --help help --resume-pending completion mcp" -- "\$cur") )
    return
  fi

  if [[ "\${words[0]}" == "mcp" ]]; then
    if [[ "\${prev}" == "--events" ]]; then
      COMPREPLY=( \$(compgen -f "\$cur") )
      return
    fi
    if [[ \${cword} -eq 1 ]]; then
      COMPREPLY=( \$(compgen -f -G "*.haril" "\$cur") )
      return
    fi
  fi

  if [[ "\${words[0]}" == "completion" ]]; then
    COMPREPLY=( \$(compgen -W "bash zsh fish powershell" -- "$cur") )
    return
  fi

  COMPREPLY=()
}
complete -F _haril haril
`,
  zsh: `#compdef haril
_haril() {
  _arguments -C \\
    '1: :->cmd' \\
    '*::arg:->args'
  case \$state in
    cmd)
      _values 'commands' \\
        '--version[show version]' \\
        '--help[show help]' \\
        'help[show help]' \\
        '--resume-pending[resume pending capture]' \\
        'completion[print shell completion script]' \\
        'mcp[run MCP stdio server]'
      ;;
    args)
      case \$words[1] in
        completion)
          _values 'shells' bash zsh fish powershell
          ;;
      esac
      ;;
  esac
}
compdef _haril haril
`,
  fish: `function __haril_completion
  set -l current (commandline -opc)
  set -l current (commandline -ct)
  switch (count $current)
    case 1
      echo --version --help help --resume-pending completion mcp
    case 2
      switch $current[1]
        case completion
          echo bash zsh fish powershell
      end
  end
end
complete -c haril -f -a "(__haril_completion)"
`,
  powershell: `using namespace System.Management.Automation
using namespace System.Management.Automation.Language
Register-ArgumentCompleter -Native -CommandName 'haril' -ScriptBlock {
  param(\$wordToComplete, \$commandAst, \$cursorPosition)
  \$tokens = \$commandAst.Extent.Text.Split(' ')
  if (\$tokens.Count -le 2) {
    @('--version', '--help', 'help', '--resume-pending', 'completion', 'mcp') |
      Where-Object { \$_ -like "\$wordToComplete*" } |
      ForEach-Object { [CompletionResult]::new(\$_, \$_, 'ParameterName', \$_) }
  }
  elseif (\$tokens[1] -eq 'completion') {
    @('bash', 'zsh', 'fish', 'powershell') |
      Where-Object { \$_ -like "\$wordToComplete*" } |
      ForEach-Object { [CompletionResult]::new(\$_, \$_, 'ParameterName', \$_) }
  }
}
`,
};

export function runCompletion(shell: string): void {
  const script = SCRIPTS[shell];
  if (!script) {
    console.error(`unknown shell: ${shell}`);
    console.error("supported: bash, zsh, fish, powershell");
    process.exit(2);
  }
  process.stdout.write(script + "\n");
}