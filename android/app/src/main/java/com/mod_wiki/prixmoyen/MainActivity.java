package com.mod_wiki.prixmoyen;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Ouvre WikiMasters dans une WebView et y injecte le script qui affiche
 * le prix de vente moyen sur chaque carte de la collection.
 */
public class MainActivity extends Activity {

    private static final String HOME = "https://www.wiki-masters.com/collection";

    private WebView web;
    private TextView errorView;
    private String script;
    private boolean scriptAtDocumentStart;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0D0D0D"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0D0D0D"));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        errorView = new TextView(this);
        errorView.setText(R.string.error_offline);
        errorView.setTextColor(Color.parseColor("#D1D5DB"));
        errorView.setTextSize(16);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(64, 64, 64, 64);
        errorView.setBackgroundColor(Color.parseColor("#0D0D0D"));
        errorView.setVisibility(View.GONE);
        errorView.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            web.reload();
        });
        root.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // nécessaire pour le site et le cache des prix
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true); // vérification Cloudflare à la connexion

        script = readAsset("prix-moyen.js");
        installScript();

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            Uri data = getIntent() != null ? getIntent().getData() : null;
            web.loadUrl(data != null && isSiteHost(data.getHost()) ? data.toString() : HOME);
        }
    }

    /** Injecte le script au tout début de chaque page du site (avant le code du site). */
    private void installScript() {
        if (script == null) return;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> origins = new HashSet<>();
            origins.add("https://www.wiki-masters.com");
            origins.add("https://wiki-masters.com");
            WebViewCompat.addDocumentStartJavaScript(web, script, origins);
            scriptAtDocumentStart = true;
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (("https".equals(scheme) || "http".equals(scheme))
                    && (isSiteHost(uri.getHost()) || "challenges.cloudflare.com".equals(uri.getHost()))) {
                return false; // reste dans l'application
            }
            // Tout le reste (Wikipédia, liens externes, mailto…) s'ouvre à l'extérieur.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) { }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // Repli pour les très vieilles WebView : injection dès le début du chargement.
            if (!scriptAtDocumentStart && script != null && url != null
                    && isSiteHost(Uri.parse(url).getHost())) {
                view.evaluateJavascript(script, null);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!scriptAtDocumentStart && script != null && url != null
                    && isSiteHost(Uri.parse(url).getHost())) {
                view.evaluateJavascript(script, null); // sans effet si déjà présent
            }
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) errorView.setVisibility(View.VISIBLE);
        }
    }

    private static boolean isSiteHost(String host) {
        return "www.wiki-masters.com".equals(host) || "wiki-masters.com".equals(host);
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent.getData();
        if (data != null && isSiteHost(data.getHost())) web.loadUrl(data.toString());
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush(); // garde la session après fermeture
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
