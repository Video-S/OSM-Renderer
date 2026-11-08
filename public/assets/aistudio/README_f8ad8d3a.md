# One-time BGT reference-data collection

This is the only action needed from the user to enable the independent road geometry evaluation.

## Requirements

- Python 3.10+ (no pip installs, GIS libraries, API key or account needed).
- Internet connectivity to `api.pdok.nl`.

## Run

1. Unzip the supplied `bgt_data_request.zip`.
2. Open a terminal **inside** the extracted `bgt_data_request` directory.
3. Run:

   ```bash
   python download_bgt.py
   ```

   On Windows, `py download_bgt.py` also works.

4. Upload the generated **`bgt_reference_data.zip`** to this conversation. No need to upload the whole folder.

This downloads six previously chosen Amsterdam 80m-scale evaluation areas from PDOK's **BGT `wegdeel`** API, following pagination and storing raw polygon features, their classifications and historical metadata. The archive is expected to be relatively small, but its size depends on the feature count.

Do not change the selected locations; keeping them frozen is necessary for an unbiased experiment.

### Error handling

If the script fails, send the error message. You can try the connection using `python download_bgt.py --site A01`; re-running without `--site` resumes from previously saved sites. Avoid manually editing GeoJSON.

## What this does not do

It doesn't access your repository, inspect E2, change any road-rendering code, install packages, or upload anything to the Internet except GET requests to the public BGT endpoint. BGT data is CC0; the original OSM data remains independently licensed under ODbL. This download is reference data, **not an algorithm or accuracy result**.

Official BGT API: https://api.pdok.nl/lv/bgt/ogc/v1/
