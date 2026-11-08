package com.moneylab.superledger.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Decorative calendar radar. The complete native service list below owns accessible edit actions. */
public final class SubscriptionRadarView extends View {
    private static final int MAX_STARS=12;
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    private final List<Star> stars=new ArrayList<>();
    private final float density;
    private final int inRange;
    private int past,future,unset;

    private static final class Star {
        final String name;
        final long days;
        final int color,background;
        final boolean active;
        final Drawable logo;
        Star(String name,long days,int color,int background,boolean active,Drawable logo){this.name=name;this.days=days;this.color=color;this.background=background;this.active=active;this.logo=logo;}
    }
    public SubscriptionRadarView(Context context,JSONObject overview)throws Exception {
        super(context);density=context.getResources().getDisplayMetrics().density;
        JSONArray rows=overview.getJSONArray("rows");String today=overview.getString("today");
        for(int i=0;i<rows.length();i++){
            JSONObject row=rows.getJSONObject(i);Long days=SubscriptionOverview.radarDays(row,today);
            if(days==null){unset++;continue;}if(days<0){past++;continue;}if(days>30){future++;continue;}
            JSONObject sub=row.getJSONObject("sub");int color=MobileStyle.ACCENT;
            try{color=Color.parseColor(sub.optString("color"));}catch(IllegalArgumentException ignored){}
            String brandId=BrandIcons.forSubscription(sub);boolean active=sub.getBoolean("active");
            int resource=BrandIcons.resource(brandId);Drawable logo=resource==0?null:context.getDrawable(resource);
            stars.add(new Star(sub.getString("name"),days,color,BrandIcons.logoBackground(brandId,Color.WHITE,active),active,logo));
        }
        Collections.sort(stars,(left,right)->Long.compare(left.days,right.days));inRange=stars.size();
        if(stars.size()>MAX_STARS)stars.subList(MAX_STARS,stars.size()).clear();
        setFocusable(true);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentDescription("订阅星图，7、15、30天轨道，越接近中心日期越近。30天内共"+inRange+"项，过期或逾期"+past+"项，30天外"+future+"项，未设日期"+unset+"项。全部服务可在下方列表编辑。");
    }
    public String outsideSummary(){return "过期／逾期 "+past+" 项 · 30 天外 "+future+" 项 · 未设日期 "+unset+" 项";}
    public String plottedSummary(){return inRange>MAX_STARS?"轨道展示最近 "+MAX_STARS+" 项，全部服务见下方列表。":"圆点按会员到期或连续订阅续费日期定位，灰点表示已暂停记账。";}
    private float dp(float value){return value*density;}
    @Override protected void onMeasure(int widthSpec,int heightSpec){
        int width=MeasureSpec.getSize(widthSpec);if(MeasureSpec.getMode(widthSpec)==MeasureSpec.UNSPECIFIED)width=MobileStyle.dp(getContext(),320);
        int height=resolveSize(Math.max(MobileStyle.dp(getContext(),260),Math.min(width,MobileStyle.dp(getContext(),360))),heightSpec);
        setMeasuredDimension(width,height);
    }
    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);float centerX=getWidth()/2f,centerY=getHeight()/2f+dp(4),outer=Math.min(getWidth(),getHeight())/2f-dp(27),inner=dp(40);
        paint.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));paint.setTextAlign(Paint.Align.CENTER);
        for(int days:new int[]{7,15,30}){
            float radius=inner+(outer-inner)*days/30f;
            paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(1));paint.setColor(0xFFDACFF0);canvas.drawCircle(centerX,centerY,radius,paint);
            paint.setStyle(Paint.Style.FILL);paint.setColor(0xFFF2ECFC);canvas.drawRoundRect(centerX-dp(21),centerY-radius-dp(9),centerX+dp(21),centerY-radius+dp(8),dp(8),dp(8),paint);
            paint.setColor(MobileStyle.ACCENT);paint.setTextSize(dp(10));canvas.drawText(days+" 天",centerX,centerY-radius+dp(3),paint);
        }
        for(int i=0;i<stars.size();i++){
            Star star=stars.get(i);double angle=Math.toRadians(-65+i*137.507764);
            float radius=inner+(outer-inner)*star.days/30f,x=centerX+(float)Math.cos(angle)*radius,y=centerY+(float)Math.sin(angle)*radius;
            paint.setColor(MobileStyle.blend(Color.WHITE,star.active?star.color:MobileStyle.MUTED,.14f));canvas.drawCircle(x,y,dp(19),paint);
            paint.setColor(star.background);canvas.drawCircle(x,y,dp(15),paint);
            if(star.logo!=null){
                int half=Math.round(dp(11));star.logo.setAlpha(star.active||star.background!=Color.WHITE?255:150);star.logo.setBounds(Math.round(x)-half,Math.round(y)-half,Math.round(x)+half,Math.round(y)+half);star.logo.draw(canvas);
            }else{
                paint.setColor(star.active?star.color:MobileStyle.MUTED);paint.setTextSize(dp(13));String initial=new String(Character.toChars(star.name.codePointAt(0)));canvas.drawText(initial,x,y+dp(4),paint);
            }
            paint.setColor(star.active?MobileStyle.ACCENT:MobileStyle.MUTED);canvas.drawCircle(x+dp(11),y+dp(11),dp(3),paint);
        }
        paint.setShader(new RadialGradient(centerX,centerY,dp(28),0xFFB99AE6,MobileStyle.ACCENT,Shader.TileMode.CLAMP));canvas.drawCircle(centerX,centerY,dp(27),paint);paint.setShader(null);
        paint.setColor(Color.WHITE);paint.setTextSize(dp(17));canvas.drawText(String.valueOf(inRange),centerX,centerY-dp(1),paint);
        paint.setTextSize(dp(9));canvas.drawText("30 天内",centerX,centerY+dp(13),paint);
        if(stars.isEmpty()){paint.setColor(MobileStyle.MUTED);paint.setTextSize(dp(11));canvas.drawText("暂无 30 天内的日期",centerX,getHeight()-dp(11),paint);}
    }
}
