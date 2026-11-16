# OKAD AFRICA - Static single-page app
# Root serves the main app as index.html

import shutil, os
shutil.copy('okad_africa_app.html', 'index.html')
print('✓ Copied okad_africa_app.html → index.html (for Vercel root)')