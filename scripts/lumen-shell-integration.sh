#!/usr/bin/env bash

# Report the current directory using the terminal-standard OSC 7 sequence.
# Safe to source repeatedly and preserves an existing PROMPT_COMMAND.
if [[ -z ${LUMEN_SHELL_INTEGRATION:-} ]]; then
  export LUMEN_SHELL_INTEGRATION=1

  __lumen_report_cwd() {
    printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$PWD"
  }

  case ";${PROMPT_COMMAND:-};" in
    *";__lumen_report_cwd;"*) ;;
    *) PROMPT_COMMAND="__lumen_report_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
