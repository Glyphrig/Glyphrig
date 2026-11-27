#!/usr/bin/env bash
# ==============================================================================
# Glyphrig Release & Version Tagger
# ==============================================================================
# Usage:
#   ./scripts/release-tagger.sh patch            # e.g. 0.5.1 -> 0.5.2 (no confirm)
#   ./scripts/release-tagger.sh minor            # e.g. 0.5.1 -> 0.6.0 (prompts for confirmation)
#   ./scripts/release-tagger.sh major            # e.g. 0.5.1 -> 1.0.0 (prompts for confirmation)
#   ./scripts/release-tagger.sh 0.5.2            # Explicit version
#   ./scripts/release-tagger.sh patch --push     # Also push commit and tag to origin
#   ./scripts/release-tagger.sh minor -y         # Skip confirmation prompt for minor/major
#   ./scripts/release-tagger.sh patch --dry-run  # Preview without modifying files or git
#   ./scripts/release-tagger.sh --skip-checks    # Skip build, typecheck, and test
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

TARGET_ARG="patch"
PUSH_FLAG=false
YES_FLAG=false
DRY_RUN=false
SKIP_CHECKS=false

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --push|-p)
      PUSH_FLAG=true
      shift
      ;;
    --yes|-y)
      YES_FLAG=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "Error: Unknown option \"$1\"." >&2
      usage >&2
      exit 1
      ;;
    *)
      TARGET_ARG="$1"
      shift
      ;;
  esac
done

if [ -n "$(git status --porcelain -- ':!.agents' ':!skills-lock.json')" ]; then
  echo "Error: Working tree has uncommitted changes. Commit or stash them before running release-tagger.sh." >&2
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"

IFS="." read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
PATCH="${PATCH%%-*}"

case "${TARGET_ARG}" in
  patch)
    NEW_PATCH=$((PATCH + 1))
    NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"
    ;;
  minor)
    NEW_MINOR=$((MINOR + 1))
    NEW_VERSION="${MAJOR}.${NEW_MINOR}.0"
    ;;
  major)
    NEW_MAJOR=$((MAJOR + 1))
    NEW_VERSION="${NEW_MAJOR}.0.0"
    ;;
  v*)
    NEW_VERSION="${TARGET_ARG#v}"
    ;;
  *)
    if [[ "${TARGET_ARG}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-].+)?$ ]]; then
      NEW_VERSION="${TARGET_ARG}"
    else
      echo "Error: Unknown argument \"${TARGET_ARG}\"." >&2
      usage >&2
      exit 1
    fi
    ;;
esac

if ! [[ "${NEW_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-].+)?$ ]]; then
  echo "Error: Invalid version \"${NEW_VERSION}\"." >&2
  exit 1
fi

IFS="." read -r NEW_MAJ NEW_MIN NEW_PAT <<< "${NEW_VERSION}"
NEW_PAT="${NEW_PAT%%-*}"

RELEASE_TYPE="patch"
if [ "${TARGET_ARG}" == "major" ] || [ "${NEW_MAJ:-0}" -gt "${MAJOR:-0}" ]; then
  RELEASE_TYPE="major"
elif [ "${TARGET_ARG}" == "minor" ] || [ "${NEW_MIN:-0}" -gt "${MINOR:-0}" ]; then
  RELEASE_TYPE="minor"
fi

TAG_NAME="v${NEW_VERSION}"

echo "============================================================"
echo " Glyphrig Release Tagger"
echo " Current Version: ${CURRENT_VERSION}"
echo " New Version:     ${NEW_VERSION} (${TAG_NAME}) [${RELEASE_TYPE}]"
if [ "${DRY_RUN}" = true ]; then
  echo " Mode:            DRY RUN (no files or git state modified)"
fi
echo "============================================================"

if git rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  echo "Error: Tag ${TAG_NAME} already exists in git!" >&2
  exit 1
fi

if [ "${RELEASE_TYPE}" == "major" ] || [ "${RELEASE_TYPE}" == "minor" ]; then
  if [ "${YES_FLAG}" != true ] && [ "${DRY_RUN}" != true ]; then
    echo ""
    echo "Attention: You are about to initiate a ${RELEASE_TYPE^^} release (${CURRENT_VERSION} -> ${NEW_VERSION})."
    read -r -p "Are you sure you want to proceed with this ${RELEASE_TYPE} release? [y/N]: " CONFIRMATION

    if [[ ! "${CONFIRMATION}" =~ ^[yY]([eE][sS])?$ ]]; then
      echo "Release aborted by user."
      exit 1
    fi
    echo ""
  fi
fi

PACKAGE_FILES=(
  package.json
  packages/core/package.json
  packages/cli/package.json
  packages/site/package.json
  apps/extension/package.json
  apps/githubio/package.json
)

if [ "${SKIP_CHECKS}" != true ]; then
  echo ">> Running build, typecheck, and tests..."
  pnpm build
  pnpm typecheck
  pnpm test
fi

if [ "${DRY_RUN}" = true ]; then
  echo ">> [dry-run] Would update version to ${NEW_VERSION} in:"
  for pkg in "${PACKAGE_FILES[@]}"; do
    [ -f "${pkg}" ] && echo "   - ${pkg}"
  done
  echo ">> [dry-run] Would commit and create tag ${TAG_NAME}"
  if [ "${PUSH_FLAG}" = true ]; then
    echo ">> [dry-run] Would push HEAD and ${TAG_NAME} to origin"
  fi
  exit 0
fi

echo ">> Updating package.json files to ${NEW_VERSION}..."
STAGE_FILES=()
for pkg in "${PACKAGE_FILES[@]}"; do
  if [ -f "${pkg}" ]; then
    node -e '
      const fs = require("fs");
      const [, pkgPath, newVersion] = process.argv;
      const json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      json.version = newVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
    ' "${pkg}" "${NEW_VERSION}"
    STAGE_FILES+=("${pkg}")
  fi
done

echo ">> Staging and creating git commit..."
git add -- "${STAGE_FILES[@]}"
git commit -m "chore(release): bump version to ${NEW_VERSION}"

echo ">> Creating git tag ${TAG_NAME}..."
git tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"

echo "============================================================"
echo " Successfully created release ${TAG_NAME}!"
echo " Commit: $(git rev-parse --short HEAD)"
echo " Tag:    ${TAG_NAME}"
echo "============================================================"

if [ "${PUSH_FLAG}" = true ]; then
  echo ">> Pushing HEAD and tag to origin..."
  git push origin HEAD
  git push origin "${TAG_NAME}"
  echo ">> Pushed! GitHub Actions workflow \"Release Packages & Extension Bundles\" will now trigger on tag ${TAG_NAME}."
else
  echo ""
  echo "To trigger GitHub Actions release build, push branch and tag:"
  echo "  git push origin main"
  echo "  git push origin ${TAG_NAME}"
  echo ""
  echo "Or re-run this script with --push next time:"
  echo "  ./scripts/release-tagger.sh [patch|minor|major] --push"
fi
