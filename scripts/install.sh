#!/usr/bin/env bash
set -euo pipefail

PROFILE="pi-ghost"
SOURCE=""
DEST="${PI_AGENT_CONFIG_DEST:-}"
AGENT_DIR="${PI_AGENT_DIR:-}"
LAUNCHER="${PI_AGENT_LAUNCHER:-}"
LAUNCHER_DISABLED="0"
PI_CLI_INSTALL_DISABLED="0"
UPDATE_DISABLED="0"
FORCE="0"
DRY_RUN="0"
CONFIG_ONLY="${PI_AGENT_CONFIG_ONLY:-0}"
PI_CLI_PACKAGE="${PI_AGENT_PI_CLI_PACKAGE:-@earendil-works/pi-coding-agent}"
RAW_BASE_URL="${PI_AGENT_RAW_BASE_URL:-https://raw.githubusercontent.com/Ghost233/pi-agent/main}"

usage() {
  cat <<'USAGE'
Usage:
  install.sh [--profile pi-ghost] [--source path-or-url] [--agent-dir path] [--dest path] [--launcher path] [--no-launcher] [--no-pi-install] [--no-update] [--force] [--config-only] [--dry-run]

Defaults:
  profile: pi-ghost
  agent:   agent_dir from profile, or ~/.pi/agent-<profile>
  dest:    target_config from profile, or <agent>/profile.toml
  mode:    install isolated Pi profile, launcher, and enabled extensions

Environment:
  PI_AGENT_CONFIG_DEST   Override destination config path.
  PI_AGENT_DIR           Override isolated Pi agent directory.
  PI_AGENT_LAUNCHER      Override launcher path.
  PI_AGENT_CONFIG_ONLY   Set to 1 to skip extension installation.
  PI_AGENT_PI_CLI_PACKAGE Override Pi CLI npm package.
  PI_AGENT_RAW_BASE_URL  Override raw repository base URL.
  PI_AGENT_CONFIG_URL    Download a specific config URL.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:?missing value for --profile}"
      shift 2
      ;;
    --source)
      SOURCE="${2:?missing value for --source}"
      shift 2
      ;;
    --agent-dir)
      AGENT_DIR="${2:?missing value for --agent-dir}"
      shift 2
      ;;
    --dest)
      DEST="${2:?missing value for --dest}"
      shift 2
      ;;
    --launcher)
      LAUNCHER="${2:?missing value for --launcher}"
      shift 2
      ;;
    --no-launcher)
      LAUNCHER_DISABLED="1"
      shift
      ;;
    --no-pi-install)
      PI_CLI_INSTALL_DISABLED="1"
      shift
      ;;
    --no-update)
      UPDATE_DISABLED="1"
      shift
      ;;
    --force)
      FORCE="1"
      shift
      ;;
    --config-only)
      CONFIG_ONLY="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

expand_path() {
  case "$1" in
    '~')
      printf '%s\n' "$HOME"
      ;;
    '~/'*)
      printf '%s/%s\n' "$HOME" "${1:2}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

profile_value() {
  awk -F= -v section="$1" -v key="$2" '
    /^\[/ {
      current = $0
      gsub(/^\[|\]$/, "", current)
      next
    }
    current == section && $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value = $2
      sub(/[[:space:]]*#.*/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$TMP_FILE"
}

profile_bool() {
  value="$(profile_value "$1" "$2")"
  if [ -z "$value" ]; then
    printf '%s\n' "$3"
  else
    printf '%s\n' "$value"
  fi
}

extension_sources() {
  awk -F= '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      return value
    }
    function flush() {
      if (in_extension && source != "" && enabled != "false") {
        print source
      }
    }
    /^\[\[extensions\]\]/ {
      flush()
      in_extension = 1
      source = ""
      enabled = "true"
      next
    }
    /^\[/ {
      flush()
      in_extension = 0
      next
    }
    in_extension && $1 ~ /^[[:space:]]*source[[:space:]]*$/ {
      value = $2
      sub(/[[:space:]]*#.*/, "", value)
      source = trim(value)
      next
    }
    in_extension && $1 ~ /^[[:space:]]*enabled[[:space:]]*$/ {
      value = $2
      sub(/[[:space:]]*#.*/, "", value)
      enabled = trim(value)
      next
    }
    END {
      flush()
    }
  ' "$TMP_FILE"
}

ensure_pi_cli() {
  if [ "$INSTALL_PI_CLI" = "true" ]; then
    install_pi_cli
  elif ! command -v pi >/dev/null 2>&1; then
    echo "Pi CLI not found. Install Pi first, or rerun with --config-only to skip extensions." >&2
    exit 1
  fi

  if ! PI_CODING_AGENT_DIR="$AGENT_DIR" pi --help >/dev/null 2>&1; then
    echo "Pi CLI is present but failed to start. Fix Pi first, or rerun with --config-only to skip extensions." >&2
    exit 1
  fi
}

install_pi_cli() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "Pi CLI not found, and npm is required to install $PI_CLI_PACKAGE." >&2
    exit 1
  fi

  echo "pi-cli: installing/updating $PI_CLI_PACKAGE"
  npm install -g "$PI_CLI_PACKAGE"
  hash -r 2>/dev/null || true

  if ! command -v pi >/dev/null 2>&1; then
    echo "Installed $PI_CLI_PACKAGE, but pi is still not available in PATH." >&2
    exit 1
  fi
}

install_launcher() {
  launcher="$1"
  agent_dir="$2"

  if [ -z "$launcher" ]; then
    return 0
  fi

  tmp_launcher="$(mktemp)"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'set -euo pipefail'
    printf 'export PI_CODING_AGENT_DIR=%q\n' "$agent_dir"
    printf '%s\n' 'exec pi "$@"'
  } > "$tmp_launcher"

  if [ "$DRY_RUN" = "1" ]; then
    if [ -f "$launcher" ] && cmp -s "$tmp_launcher" "$launcher"; then
      echo "dry-run: launcher unchanged $launcher"
    else
      echo "dry-run: would install launcher $launcher"
    fi
    rm -f "$tmp_launcher"
    return 0
  fi

  if [ -f "$launcher" ] && cmp -s "$tmp_launcher" "$launcher"; then
    rm -f "$tmp_launcher"
    echo "launcher: unchanged $launcher"
    return 0
  fi

  launcher_dir="$(dirname "$launcher")"
  install -d "$launcher_dir"
  cp "$tmp_launcher" "$launcher"
  rm -f "$tmp_launcher"
  chmod 755 "$launcher"
  echo "launcher: $launcher"
}

install_profile() {
  source_file="$1"
  dest_file="$2"
  dest_dir="$(dirname "$dest_file")"

  if [ "$DRY_RUN" = "1" ]; then
    if [ -f "$dest_file" ] && cmp -s "$source_file" "$dest_file"; then
      echo "dry-run: profile unchanged $dest_file"
    else
      echo "dry-run: would install profile $dest_file"
    fi
    return 0
  fi

  if [ -f "$dest_file" ] && cmp -s "$source_file" "$dest_file"; then
    chmod 600 "$dest_file"
    echo "profile: unchanged $dest_file"
    return 0
  fi

  if [ -e "$dest_file" ] && [ "$BACKUP_EXISTING" = "true" ]; then
    backup_file "$dest_file"
  fi

  install -d "$AGENT_DIR"
  install -d "$dest_dir"
  cp "$source_file" "$dest_file"
  chmod 600 "$dest_file"
  echo "profile: installed $dest_file"
}

package_installed() {
  package_source="$1"
  settings_file="$AGENT_DIR/settings.json"

  if [ ! -f "$settings_file" ]; then
    return 1
  fi

  grep -Fq "\"$package_source\"" "$settings_file" && return 0
  grep -Fq "\"source\":\"$package_source\"" "$settings_file" && return 0
  grep -Fq "\"source\": \"$package_source\"" "$settings_file"
}

backup_file() {
  file="$1"
  if [ ! -e "$file" ]; then
    return 0
  fi

  backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "dry-run: would backup $file to $backup"
  else
    cp "$file" "$backup"
    echo "backup: $backup"
  fi
}

if [ -z "$SOURCE" ] && [ -n "${PI_AGENT_CONFIG_URL:-}" ]; then
  SOURCE="$PI_AGENT_CONFIG_URL"
fi

SCRIPT_PATH="${BASH_SOURCE[0]:-${0:-}}"
LOCAL_PROFILE=""

if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  LOCAL_PROFILE="$SCRIPT_DIR/../profiles/$PROFILE.toml"
fi

if [ -z "$SOURCE" ]; then
  if [ -n "$LOCAL_PROFILE" ] && [ -f "$LOCAL_PROFILE" ]; then
    SOURCE="$LOCAL_PROFILE"
  else
    SOURCE="$RAW_BASE_URL/profiles/$PROFILE.toml"
  fi
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

case "$SOURCE" in
  https://*|http://*)
    if ! command -v curl >/dev/null 2>&1; then
      echo "curl is required to download $SOURCE" >&2
      exit 1
    fi
    curl -fsSL "$SOURCE" -o "$TMP_FILE"
    ;;
  *)
    if [ ! -f "$SOURCE" ]; then
      echo "Config source not found: $SOURCE" >&2
      exit 1
    fi
    cp "$SOURCE" "$TMP_FILE"
    ;;
esac

if ! grep -Eq '^version[[:space:]]*=[[:space:]]*[0-9]+' "$TMP_FILE"; then
  echo "Invalid config: missing numeric version" >&2
  exit 1
fi

if ! grep -Eq '^profile[[:space:]]*=' "$TMP_FILE"; then
  echo "Invalid config: missing profile" >&2
  exit 1
fi

if [ -z "$AGENT_DIR" ]; then
  AGENT_DIR="$(profile_value local agent_dir)"
fi

if [ -z "$AGENT_DIR" ]; then
  AGENT_DIR="~/.pi/agent-$PROFILE"
fi

AGENT_DIR="$(expand_path "$AGENT_DIR")"

if [ -z "$DEST" ]; then
  DEST="$(profile_value local target_config)"
fi

if [ -z "$DEST" ]; then
  DEST="$AGENT_DIR/profile.toml"
fi

DEST="$(expand_path "$DEST")"
DEST_DIR="$(dirname "$DEST")"

if [ -z "$LAUNCHER" ]; then
  LAUNCHER="$(profile_value local launcher)"
fi

if [ -z "$LAUNCHER" ]; then
  LAUNCHER="~/.local/bin/$PROFILE"
fi

LAUNCHER="$(expand_path "$LAUNCHER")"
BACKUP_EXISTING="$(profile_bool install backup_existing true)"
INSTALL_PI_CLI="$(profile_bool install install_pi_cli true)"
INSTALL_EXTENSIONS="$(profile_bool install install_extensions true)"
UPDATE_EXTENSIONS="$(profile_bool install update_extensions true)"
CREATE_LAUNCHER="$(profile_bool install create_launcher true)"
EXTENSION_SOURCES="$(extension_sources)"

if [ "$LAUNCHER_DISABLED" = "1" ]; then
  CREATE_LAUNCHER="false"
fi

if [ "$PI_CLI_INSTALL_DISABLED" = "1" ]; then
  INSTALL_PI_CLI="false"
fi

if [ "$UPDATE_DISABLED" = "1" ]; then
  UPDATE_EXTENSIONS="false"
fi

echo "pi-agent config restore"
echo "  source: $SOURCE"
echo "  agent:  $AGENT_DIR"
echo "  dest:   $DEST"
if [ "$CREATE_LAUNCHER" = "true" ]; then
  echo "  launch: $LAUNCHER"
fi

if [ -n "$EXTENSION_SOURCES" ] && [ "$CONFIG_ONLY" != "1" ] && [ "$INSTALL_EXTENSIONS" = "true" ] && [ "$DRY_RUN" = "1" ] && [ "$INSTALL_PI_CLI" = "true" ]; then
  echo "dry-run: would install/update Pi CLI $PI_CLI_PACKAGE"
fi

if [ -n "$EXTENSION_SOURCES" ] && [ "$CONFIG_ONLY" != "1" ] && [ "$INSTALL_EXTENSIONS" = "true" ] && [ "$DRY_RUN" != "1" ]; then
  ensure_pi_cli
fi

install_profile "$TMP_FILE" "$DEST"

if [ "$CREATE_LAUNCHER" = "true" ]; then
  install_launcher "$LAUNCHER" "$AGENT_DIR"
else
  echo "launcher: skipped"
fi

if [ -n "$EXTENSION_SOURCES" ]; then
  if [ "$CONFIG_ONLY" = "1" ] || [ "$INSTALL_EXTENSIONS" != "true" ]; then
    echo "extensions: skipped"
  elif [ "$DRY_RUN" = "1" ]; then
    has_installed_extension="0"

    while IFS= read -r extension_source; do
      if [ -n "$extension_source" ]; then
        if [ "$FORCE" != "1" ] && package_installed "$extension_source"; then
          has_installed_extension="1"
          echo "dry-run: extension already installed $extension_source"
        else
          echo "dry-run: would install extension $extension_source"
        fi
      fi
    done <<EOF
$EXTENSION_SOURCES
EOF

    if [ "$UPDATE_EXTENSIONS" = "true" ] && [ "$has_installed_extension" = "1" ]; then
      echo "dry-run: would update installed extensions"
    fi
  else
    has_installed_extension="0"

    while IFS= read -r extension_source; do
      if [ -z "$extension_source" ]; then
        continue
      fi

      if [ "$FORCE" != "1" ] && package_installed "$extension_source"; then
        has_installed_extension="1"
        echo "extension: already installed $extension_source"
        continue
      fi

      PI_CODING_AGENT_DIR="$AGENT_DIR" pi install "$extension_source"
    done <<EOF
$EXTENSION_SOURCES
EOF

    if [ "$UPDATE_EXTENSIONS" = "true" ] && [ "$has_installed_extension" = "1" ]; then
      PI_CODING_AGENT_DIR="$AGENT_DIR" pi update --extensions
    fi
  fi
fi

echo "done."
