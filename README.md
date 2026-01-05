# Zwift Route Tracker

A simple web application to track your progress completing all Zwift routes. Hosted on GitHub Pages with multi-device sync via GitHub Gist.

## Features

- View all 223 Zwift routes organized by map/location
- Mark routes as completed (requires authentication)
- Track progress with statistics (total, completed, remaining, percentage)
- Filter routes: All / Completed / Remaining
- Search routes by name or map
- Multi-device sync via GitHub Gist
- Public viewing (perfect for sharing on Strava)
- Authenticated editing (only you can mark routes)

## Setup Instructions

### 1. Enable GitHub Pages

1. Go to your repository settings on GitHub
2. Navigate to "Pages" in the left sidebar
3. Under "Source", select:
   - **Branch**: `main` (or your default branch)
   - **Folder**: `/ (root)`
4. Click "Save"
5. Your site will be available at: `https://[username].github.io/[repository-name]`

### 2. Create a GitHub Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give it a descriptive name (e.g., "Zwift Route Tracker")
4. Select the `gist` scope (this allows creating and updating Gists)
5. Click "Generate token"
6. **Copy the token immediately** - you won't be able to see it again!

### 3. Initial Setup

1. Open your GitHub Pages site
2. Click "Login to Edit"
3. Paste your GitHub Personal Access Token
4. Click "Use Token"
5. If you have an existing Gist with your progress:
   - Enter the Gist ID in the "Gist Setup" section
   - Click "Save Gist ID"
6. If you don't have a Gist yet:
   - The app will automatically create one when you mark your first route as completed

### 4. Using the Tracker

- **Viewing**: Anyone can view your progress (perfect for Strava links!)
- **Editing**: Click "Login to Edit" and enter your token to mark routes as completed
- **Filtering**: Use the filter buttons to show All, Completed, or Remaining routes
- **Searching**: Type in the search box to find specific routes
- **Grouping**: Routes are grouped by map/location with collapsible sections

## File Structure

```
/
├── index.html          # Main HTML page
├── app.js              # Application logic
├── styles.css          # Styling
├── routes.json         # Route data (converted from routes.csv)
├── routes.csv          # Original route data
└── README.md           # This file
```

## How It Works

1. **Route Data**: Routes are loaded from `routes.json` (converted from `routes.csv`)
2. **Progress Storage**: Completed routes are stored in a GitHub Gist
3. **Authentication**: Uses GitHub Personal Access Token for write access
4. **Public Access**: Gist is public, so anyone can view your progress
5. **Multi-Device Sync**: Progress syncs across all devices via the Gist

## Security Notes

- Your GitHub token is stored in `sessionStorage` (cleared when browser closes)
- The Gist ID is stored in `localStorage` (persists across sessions)
- Never share your Personal Access Token publicly
- The Gist is public, so your progress is visible to anyone with the link

## Troubleshooting

### "Failed to load Gist"
- Make sure your Gist ID is correct
- Verify the Gist exists and is public
- Check browser console for detailed error messages

### "Failed to save progress"
- Verify your token has the `gist` scope
- Make sure your token hasn't expired
- Check that you're authenticated (token in sessionStorage)

### Routes not loading
- Ensure `routes.json` is in the repository root
- Check that GitHub Pages is serving from the correct branch
- Verify file paths are correct (case-sensitive)

## Updating Routes

If Zwift adds new routes:

1. Update `routes.csv` with new routes
2. Run the conversion script (or manually update `routes.json`):
   ```python
   import csv
   import json
   
   routes = []
   with open('routes.csv', 'r', encoding='utf-8') as f:
       reader = csv.DictReader(f)
       for row in reader:
           routes.append({
               'route': row['Route'],
               'map': row['Map'],
               'length': float(row['Length (Km)']),
               'elevation': int(row['Elevation (m)']),
               'leadIn': float(row['Lead-In (Km'])
           })
   
   with open('routes.json', 'w', encoding='utf-8') as f:
       json.dump(routes, f, indent=2, ensure_ascii=False)
   ```
3. Commit and push to GitHub
4. GitHub Pages will automatically update

## License

This project is open source and available for personal use.

