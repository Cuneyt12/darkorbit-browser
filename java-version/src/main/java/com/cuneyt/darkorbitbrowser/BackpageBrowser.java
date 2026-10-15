package com.cuneyt.darkorbitbrowser;

import org.cef.CefApp;
import org.cef.CefClient;
import org.cef.CefSettings;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefAppHandlerAdapter;
import org.cef.handler.CefDisplayHandlerAdapter;
import org.cef.handler.CefLifeSpanHandlerAdapter;
import org.cef.network.CefCookie;
import org.cef.network.CefCookieManager;

import javax.swing.JFrame;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.SwingUtilities;
import javax.swing.WindowConstants;
import java.awt.BorderLayout;
import java.awt.event.KeyEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;
import java.net.URI;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * DarkOrbit "backpage" icin Java tabanli, Flash destekli custom browser.
 *
 * Kullanim (DarkOrbit Client.exe ile ayni arguman stili):
 *   BackpageBrowser --dosid "https://int1.darkorbit.com/indexInternal.es?dosid=XXXX"
 *   BackpageBrowser --dosid XXXX --url "https://int1.darkorbit.com/indexInternal.es?action=internalStart"
 *   BackpageBrowser --instance int1 --dosid XXXX
 *
 * Flash'in calismasi icin kurulum klasorunde:
 *   - flash/pepflashplayer.dll  (Pepper Flash PPAPI eklentisi)
 *   - CEF 87 ile derlenmis JCEF native bundle'i (jcef\...)
 * bulunmalidir.
 */
public class BackpageBrowser {

    private static final String USER_AGENT = "BigpointClient/1.6.9";
    private static final String FLASH_VERSION = "32.0.0.465";

    private final Options options;
    private final File appDir;

    private JFrame frame;
    private CefBrowser browser;

    public BackpageBrowser(Options options) {
        this.options = options;
        this.appDir = resolveAppDir();
    }

    public static void main(String[] args) {
        Options options = Options.parse(args);
        BackpageBrowser app = new BackpageBrowser(options);
        SwingUtilities.invokeLater(() -> app.start(options));
    }

    private void start(Options o) {
        List<String> cefArgs = new ArrayList<>();

        File flash = new File(appDir, "flash/pepflashplayer.dll");
        if (flash.exists()) {
            cefArgs.add("--ppapi-flash-path=" + flash.getAbsolutePath());
            cefArgs.add("--ppapi-flash-version=" + FLASH_VERSION);
            cefArgs.add("--allow-outdated-plugins");
        } else {
            System.out.println("UYARI: Flash eklentisi bulunamadi: " + flash.getAbsolutePath());
        }
        cefArgs.add("--ignore-certificate-errors");

        CefApp.addAppHandler(new CefAppHandlerAdapter(cefArgs.toArray(new String[0])) {
            @Override
            public void stateHasChanged(CefApp.CefAppState state) {
                if (state == CefApp.CefAppState.TERMINATED) {
                    System.exit(0);
                }
            }
        });

        CefSettings settings = new CefSettings();
        settings.windowless_rendering_enabled = false;
        settings.user_agent = USER_AGENT;
        settings.persist_session_cookies = true;
        settings.log_severity = CefSettings.LogSeverity.LOGSEVERITY_DISABLE;
        settings.cache_path = new File(appDir, "cache").getAbsolutePath();

        CefApp cefApp;
        try {
            cefApp = CefApp.getInstance(settings);
        } catch (Throwable t) {
            t.printStackTrace();
            JOptionPane.showMessageDialog(null,
                    "CEF baslatilamadi.\n\n" + t,
                    "DarkOrbit Browser", JOptionPane.ERROR_MESSAGE);
            return;
        }

        CefClient client = cefApp.createClient();

        browser = client.createBrowser("about:blank", false, false);

        client.addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
            @Override
            public void onAfterCreated(CefBrowser b) {
                applyDosidCookie();
                if (o.targetUrl != null) {
                    b.loadURL(o.targetUrl);
                }
            }

            @Override
            public void onBeforeClose(CefBrowser b) {
                CefApp.getInstance().dispose();
                System.exit(0);
            }
        });

        client.addDisplayHandler(new CefDisplayHandlerAdapter() {
            @Override
            public void onTitleChange(CefBrowser b, String title) {
                if (frame != null && title != null && !title.isEmpty()) {
                    frame.setTitle("DarkOrbit - " + title);
                }
            }
        });

        buildFrame();
    }

    private void applyDosidCookie() {
        if (options.sid == null || options.sid.isEmpty() || options.origin == null) {
            return;
        }
        CefCookieManager manager = CefCookieManager.getGlobalManager();
        if (manager == null) {
            System.out.println("UYARI: Cookie manager alinamadi, dosid eklenemedi.");
            return;
        }
        CefCookie cookie = new CefCookie(
                "dosid", options.sid, "", "/", true, true,
                new Date(), new Date(), false, null);
        manager.setCookie(options.origin, cookie);
    }

    private void buildFrame() {
        frame = new JFrame("DarkOrbit");
        frame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        frame.setSize(1280, 800);
        frame.setLocationRelativeTo(null);
        frame.setJMenuBar(buildMenuBar());
        frame.getContentPane().add(browser.getUIComponent(), BorderLayout.CENTER);
        frame.addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                if (browser != null) {
                    browser.close(true);
                }
            }
        });
        frame.setVisible(true);
    }

    private JMenuBar buildMenuBar() {
        JMenuBar menuBar = new JMenuBar();
        JMenu view = new JMenu("View");
        view.setMnemonic(KeyEvent.VK_V);

        JMenuItem reload = new JMenuItem("Reload");
        reload.setAccelerator(javax.swing.KeyStroke.getKeyStroke(KeyEvent.VK_F5, 0));
        reload.addActionListener(e -> {
            if (browser != null) browser.reload();
        });

        JMenuItem zoomIn = new JMenuItem("Zoom in");
        zoomIn.addActionListener(e -> {
            if (browser != null) browser.setZoomLevel(browser.getZoomLevel() + 0.5);
        });

        JMenuItem zoomOut = new JMenuItem("Zoom out");
        zoomOut.addActionListener(e -> {
            if (browser != null) browser.setZoomLevel(browser.getZoomLevel() - 0.5);
        });

        JMenuItem zoomReset = new JMenuItem("Reset zoom");
        zoomReset.addActionListener(e -> {
            if (browser != null) browser.setZoomLevel(0.0);
        });

        view.add(reload);
        view.addSeparator();
        view.add(zoomIn);
        view.add(zoomOut);
        view.add(zoomReset);
        menuBar.add(view);
        return menuBar;
    }

    private static File resolveAppDir() {
        try {
            File loc = new File(BackpageBrowser.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            File dir = loc.isFile() ? loc.getParentFile() : loc;
            if (dir != null) {
                return dir;
            }
        } catch (Exception ignored) {
        }
        return new File(".").getAbsoluteFile();
    }

    /** Komut satiri argumanlari ve hedef URL/cookie cozumlemesi. */
    static class Options {
        String sid;
        String origin;
        String targetUrl;

        static Options parse(String[] args) {
            Options o = new Options();
            String dosid = null;
            String url = null;
            String instance = null;

            for (int i = 0; i < args.length; i++) {
                String a = args[i];
                String value = null;
                String key = a;
                int eq = a.indexOf('=');
                if (a.startsWith("--") && eq > 0) {
                    key = a.substring(0, eq);
                    value = a.substring(eq + 1);
                }
                switch (key) {
                    case "--dosid":
                        if (value != null) {
                            dosid = value;
                        } else if (i + 1 < args.length) {
                            dosid = args[++i];
                        }
                        break;
                    case "--url":
                        if (value != null) {
                            url = value;
                        } else if (i + 1 < args.length) {
                            url = args[++i];
                        }
                        break;
                    case "--instance":
                        if (value != null) {
                            instance = value;
                        } else if (i + 1 < args.length) {
                            instance = args[++i];
                        }
                        break;
                    default:
                        break;
                }
            }

            if (dosid != null && looksLikeUrl(dosid)) {
                o.origin = originOf(dosid);
                o.sid = queryParam(dosid, "dosid");
                if (o.sid == null) {
                    o.sid = queryParam(dosid, "sid");
                }
                if (o.origin != null) {
                    o.targetUrl = o.origin + "/indexInternal.es?action=internalStart";
                }
            } else if (dosid != null) {
                o.sid = dosid;
                if (url != null) {
                    o.origin = originOf(url);
                    o.targetUrl = url;
                } else if (instance != null) {
                    o.origin = "https://" + instance + ".darkorbit.com";
                    o.targetUrl = o.origin + "/indexInternal.es?action=internalStart";
                } else {
                    o.targetUrl = "https://www.darkorbit.com/";
                }
            } else if (url != null) {
                o.origin = originOf(url);
                o.targetUrl = url;
            } else {
                o.targetUrl = "https://www.darkorbit.com/";
            }
            return o;
        }

        private static boolean looksLikeUrl(String value) {
            return value.startsWith("http://") || value.startsWith("https://");
        }

        private static String originOf(String url) {
            try {
                URI uri = URI.create(url);
                if (uri.getScheme() != null && uri.getHost() != null) {
                    return uri.getScheme() + "://" + uri.getHost();
                }
            } catch (Exception ignored) {
            }
            return null;
        }

        private static String queryParam(String url, String name) {
            int q = url.indexOf('?');
            if (q < 0) {
                return null;
            }
            String query = url.substring(q + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && pair.substring(0, eq).equals(name)) {
                    return pair.substring(eq + 1);
                }
            }
            return null;
        }
    }
}
