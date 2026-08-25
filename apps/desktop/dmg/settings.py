from pathlib import Path


APP_ICON_POSITION = (180, 210)
APPLICATIONS_ICON_POSITION = (480, 210)
DMG_WINDOW_POSITION = (200, 120)
DMG_WINDOW_SIZE = (660, 400)

app_path = Path(defines["app"]).resolve()  # noqa: F821
background_path = Path(defines["background"]).resolve()  # noqa: F821
volume_icon_path = Path(defines["volume_icon"]).resolve()  # noqa: F821

app_name = app_path.name
files = [str(app_path)]
symlinks = {"Applications": "/Applications"}
icon = str(volume_icon_path)
background = str(background_path)

format = "UDZO"
filesystem = "HFS+"
window_rect = (DMG_WINDOW_POSITION, DMG_WINDOW_SIZE)
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

icon_size = 112
text_size = 14
label_pos = "bottom"
icon_locations = {
    app_name: APP_ICON_POSITION,
    "Applications": APPLICATIONS_ICON_POSITION,
}
hide_extensions = [app_name]
