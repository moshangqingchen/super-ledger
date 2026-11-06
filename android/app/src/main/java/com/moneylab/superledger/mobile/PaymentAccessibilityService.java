package com.moneylab.superledger.mobile;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Opt-in, read-only result-page assistance. No actions, screenshots, inputs or other apps. */
public final class PaymentAccessibilityService extends AccessibilityService {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private String activePackage="",activeClass="",lastFingerprint="";
    private int activeWindow=-1;
    private long lastRead,lastCapture;
    @Override public void onAccessibilityEvent(AccessibilityEvent event){
        if(event==null)return;
        String pkg=event.getPackageName()==null?"":event.getPackageName().toString();
        if(!PaymentPageParser.allowedPackage(pkg)){clearWindow();return;}
        try{
            LedgerStore store=LedgerStore.get(this);JSONObject snapshot=store.snapshot();
            if(!snapshot.optBoolean("captureEnabled",false)||!snapshot.optBoolean("screenCaptureEnabled",false)||!store.sourceEnabled(pkg)){clearWindow();return;}
            if(event.getEventType()==AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED){
                // A new window visit may be a distinct same-price purchase. Only coalesce
                // content updates during one visit; Store still deduplicates known order IDs.
                lastFingerprint="";lastCapture=0;lastRead=0;
                activePackage=pkg;activeClass=event.getClassName()==null?"":event.getClassName().toString();activeWindow=event.getWindowId();
            }
            if(!pkg.equals(activePackage)||event.getWindowId()!=activeWindow||!PaymentPageParser.allowedWindow(pkg,activeClass))return;
            long now=SystemClock.elapsedRealtime();if(now-lastRead<700)return;lastRead=now;
            AccessibilityNodeInfo root=getRootInActiveWindow();if(root==null)return;
            List<String> lines=new ArrayList<>();
            try{
                if(root.getPackageName()==null||!pkg.contentEquals(root.getPackageName())||root.getWindowId()!=activeWindow){clearWindow();return;}
                // A metadata-only pass rejects any editable/password/chat tree before reading text.
                int[] nodes={0};if(!scan(root,pkg,0,nodes,null)){lastFingerprint="";return;}
                nodes[0]=0;if(!scan(root,pkg,0,nodes,lines))return;
            }finally{root.recycle();}
            PaymentParser.Parsed parsed=PaymentPageParser.parse(pkg,activeClass,lines,false);if(parsed==null)return;
            String fingerprint=hash(pkg+"|"+parsed.reference+"|"+parsed.amount+"|"+parsed.merchant+"|"+parsed.fundingLabel);
            if(fingerprint.equals(lastFingerprint)&&now-lastCapture<120000)return;
            lastFingerprint=fingerprint;lastCapture=now;final long posted=System.currentTimeMillis();
            worker.execute(()->{try{
                JSONObject current=store.snapshot();if(!current.optBoolean("captureEnabled",false)||!current.optBoolean("screenCaptureEnabled",false))return;
                store.capture(pkg,"screen:"+fingerprint,posted,parsed);
                sendBroadcast(new Intent(MainActivity.ACTION_CHANGED).setPackage(getPackageName()));
            }catch(Exception ignored){store.captureFailed();}});
        }catch(Exception ignored){/* Never log or persist unparsed page contents. */}
    }
    private static boolean scan(AccessibilityNodeInfo node,String pkg,int depth,int[] count,List<String> lines){
        if(depth>20||++count[0]>160)return false;
        if(node.getPackageName()!=null&&!pkg.contentEquals(node.getPackageName()))return false;
        if(node.isEditable()||node.isPassword())return false;
        String cls=node.getClassName()==null?"":node.getClassName().toString().toLowerCase(java.util.Locale.ROOT);
        String id=node.getViewIdResourceName()==null?"":node.getViewIdResourceName().toLowerCase(java.util.Locale.ROOT);
        if(cls.contains("edittext")||id.matches(".*(?:chatting|chat_input|conversation|password|message_input).*"))return false;
        if(lines!=null&&node.isVisibleToUser()){
            CharSequence text=node.getText();if(text!=null&&!text.toString().trim().isEmpty())lines.add(text.toString());
            if(lines.size()>120)return false;
        }
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo child=node.getChild(i);if(child==null)continue;try{if(!scan(child,pkg,depth+1,count,lines))return false;}finally{child.recycle();}}
        return true;
    }
    private static String hash(String value)throws Exception {byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    private void clearWindow(){activePackage="";activeClass="";activeWindow=-1;lastFingerprint="";lastCapture=0;lastRead=0;}
    @Override public void onInterrupt(){clearWindow();}
    @Override public void onDestroy(){clearWindow();worker.shutdown();super.onDestroy();}
}
