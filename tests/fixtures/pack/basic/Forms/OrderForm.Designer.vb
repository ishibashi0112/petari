<Global.Microsoft.VisualBasic.CompilerServices.DesignerGenerated()>
Partial Class OrderForm
    Inherits System.Windows.Forms.Form

    Private components As System.ComponentModel.IContainer
    Friend WithEvents pnlHeader As System.Windows.Forms.Panel
    Friend WithEvents lblCustomer As System.Windows.Forms.Label
    Friend WithEvents txtCustomerName As System.Windows.Forms.TextBox
    Friend WithEvents btnSave As System.Windows.Forms.Button
    Friend WithEvents mnuMain As System.Windows.Forms.MenuStrip
    Friend WithEvents mnuFile As System.Windows.Forms.ToolStripMenuItem
    Friend WithEvents mnuFileExit As System.Windows.Forms.ToolStripMenuItem
    Friend WithEvents grdItems As FarPoint.Win.Spread.FpSpread
    Friend WithEvents tmrAutoSave As System.Windows.Forms.Timer

    Private Sub InitializeComponent()
        Me.components = New System.ComponentModel.Container()
        Me.pnlHeader = New System.Windows.Forms.Panel()
        Me.lblCustomer = New System.Windows.Forms.Label()
        Me.txtCustomerName = New System.Windows.Forms.TextBox()
        Me.btnSave = New System.Windows.Forms.Button()
        Me.mnuMain = New System.Windows.Forms.MenuStrip()
        Me.mnuFile = New System.Windows.Forms.ToolStripMenuItem()
        Me.mnuFileExit = New System.Windows.Forms.ToolStripMenuItem()
        Me.grdItems = New FarPoint.Win.Spread.FpSpread()
        Me.tmrAutoSave = New System.Windows.Forms.Timer(Me.components)
        Me.pnlHeader.SuspendLayout()
        Me.SuspendLayout()
        '
        'pnlHeader
        '
        Me.pnlHeader.Location = New System.Drawing.Point(0, 24)
        Me.pnlHeader.Size = New System.Drawing.Size(600, 64)
        Me.pnlHeader.Controls.Add(Me.lblCustomer)
        Me.pnlHeader.Controls.Add(Me.txtCustomerName)
        '
        'lblCustomer
        '
        Me.lblCustomer.Location = New System.Drawing.Point(8, 16)
        Me.lblCustomer.Text = "得意先"
        '
        'txtCustomerName
        '
        Me.txtCustomerName.Location = New System.Drawing.Point(80, 12)
        Me.txtCustomerName.Size = New System.Drawing.Size(240, 19)
        '
        'btnSave
        '
        Me.btnSave.Location = New System.Drawing.Point(520, 384)
        Me.btnSave.Size = New System.Drawing.Size(75, 23)
        Me.btnSave.Text = "保存"
        '
        'mnuMain
        '
        Me.mnuMain.Items.AddRange(New System.Windows.Forms.ToolStripItem() {Me.mnuFile})
        Me.mnuFile.DropDownItems.AddRange(New System.Windows.Forms.ToolStripItem() {Me.mnuFileExit})
        Me.mnuFile.Text = "ファイル(&F)"
        Me.mnuFileExit.Text = "終了(&X)"
        '
        'grdItems
        '
        Me.grdItems.Location = New System.Drawing.Point(0, 96)
        Me.grdItems.Size = New System.Drawing.Size(600, 280)
        '
        'OrderForm
        '
        Me.ClientSize = New System.Drawing.Size(608, 422)
        Me.Text = "受注入力"
        Me.Controls.Add(Me.pnlHeader)
        Me.Controls.Add(Me.btnSave)
        Me.Controls.Add(Me.grdItems)
        Me.Controls.Add(Me.mnuMain)
        Me.pnlHeader.ResumeLayout(False)
        Me.ResumeLayout(False)
    End Sub
End Class
