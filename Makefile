.PHONY: bump-version package deploy all

# Default target
all: bump-version package

# Deploy target that does both operations
deploy: bump-version package

# Bump version in both package.json files
bump-version:
	@echo "Current version in package.json:"
	@grep "\"version\":" package.json
	@echo "Current version in webview/package.json:"
	@grep "\"version\":" webview/package.json
	@read -p "What to bump? [patch]/minor/major: " type; \
	type=$${type:-patch}; \
	current_version=$$(grep "\"version\":" package.json | awk -F'"' '{print $$4}'); \
	major=$$(echo $$current_version | cut -d. -f1); \
	minor=$$(echo $$current_version | cut -d. -f2); \
	patch=$$(echo $$current_version | cut -d. -f3); \
	case $$type in \
		major) new_version=$$((major + 1)).0.0 ;; \
		minor) new_version=$$major.$$((minor + 1)).0 ;; \
		patch) new_version=$$major.$$minor.$$((patch + 1)) ;; \
		*) echo "Invalid type. Using patch."; \
		   new_version=$$major.$$minor.$$((patch + 1)) ;; \
	esac; \
	sed -i '' 's/"version": "[^"]*"/"version": "'$$new_version'"/' package.json; \
	sed -i '' 's/"version": "[^"]*"/"version": "'$$new_version'"/' webview/package.json; \
	echo "Version bumped to $$new_version"

# Package the extension
package:
	vsce package
